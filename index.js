var pg;
try {
  pg = require('pg');
} catch (e) {
  try {
    pg = require('pg.js');
  } catch (e2) {
    console.log(e2);
    throw new Error("Could not access pg module. Please install either pg or pg.js.");
  }
}

var when = require('when');
var domain = require('domain');

var DB, __logFn = null;

module.exports = function(con) { return new DB(con); };
module.exports.log = function(fn) {
  if (!!fn && typeof fn === 'function') __logFn = fn;
};

var nextId = (function() {
  var id = 0;
  return function() {
    if (id < Number.MAX_SAFE_INTEGER - 1) { id++; }
    else id = 0;
    return id;
  };
})();

// it would be nice to be able to stream result sets by returning a generator
// need a way to inject mocks for testing

DB = (function() {
  DB.displayName = 'DB';
  var prototype = DB.prototype, constructor = DB;
  var Transaction, _transact, _connect, _query, _nonQuery, _queryOne, _conStr, _setup, _name, _logFn, _pool;

  _name = '';
  _logFn = null;
  _pool = true;
  _conStr = '';
  _connect = function() {
    var deferred = when.defer();

    if (!_pool) {
      var client = new pg.Client(_conStr);
      client.connect(function(err) {
        if (err) deferred.reject(err);
        else deferred.resolve([client]);
      });
      return deferred.promise;
    } else {
      pg.connect(_conStr, function(err, client, done) {
        if (err) deferred.reject(err);
        else deferred.resolve([client, done]);
      });
      return deferred.promise;
    }
  };

  _query = function(connection, query, params) {
    var con, p, cleanup = false;
    if (!!connection) {
      p = when.defer();
      con = p.promise;
      p.resolve([connection]);
    } else if (!_hasCurrent()) {
      con = _connect();
      cleanup = true;
    } else {
      con = domain.active.__pggenContext.trans.begin();
    }

    // if a map is passed instead of an array, used named params
    if (!!params && !Array.isArray(params)) {
      var idx = 1, arr = [];
      query = query.replace(/(\$[-a-zA-Z0-9_]*)/g, function(m) {
        arr.push(params[m.slice(1)]);
        return '$' + idx++;
      });
      params = arr;
      if (idx - 1 != params.length) return when.reject("Parameter count doesn't match parameters in statement.");
    }

    return con.then(function(c) {
      var start = Date.now();

      var deferred = when.defer();
      c[0].query(query, params, function(err, res) {
        var time = Date.now() - start;

        try {
          if (_logFn !== null) _logFn({ name: _name, query: query, params: params, string: _conStr, time: time, error: err });
          else if (__logFn !== null) __logFn({ name: _name, query: query, params: params, string: _conStr, time: time, error: err });
        } catch (e) {}

        if (err) deferred.reject(err);
        else deferred.resolve(res);
        if (cleanup) {
          if (_pool) c[1]();
          else c[0].end();
        }
      });
      return deferred.promise;
    });
  };

  _nonQuery = function(connection, query, params) {
    return _query(connection, query, params).then(function(res) {
      return res.rowCount;
    });
  };

  _queryOne = function(connection, query, params) {
    return _query(connection, query, params).then(function(res) {
      if (res.rows.length > 0) {
        return res.rows[0];
      } else {
        throw new Error("No rows were returned where at least one was expected.");
      }
    });
  };

  _hasCurrent = function() {
    return !!domain.active && !!domain.active.__pggenContext && !!domain.active.__pggenContext.trans;
  };

  _current = function(fn) {
    var currentDomain = domain.active,
        initDomain = !!!currentDomain;
    if (!!!currentDomain) currentDomain = domain.create();
    var ctx = currentDomain.__pggenContext || {};
    if (!!!currentDomain.__pggenContext) currentDomain = domain.create();
    currentDomain.__pggenContext = ctx;

    var trans = ctx.trans || new Transaction(),
        startTrans = ctx.trans;
    ctx.trans = trans;

    currentDomain.run(function() {
      fn({
        domain: currentDomain,
        trans: trans,
        init: !!!startTrans
      });
    });
  };

  _transact = function(gen) {
    var deferred = when.defer();

    _current(function(ctx) { _transactMiddle(gen, deferred, ctx); });

    return deferred.promise;
  };

  _newTransact = function(gen) {
    var deferred = when.defer();

    var currentDomain = domain.create();
    var ctx = currentDomain.__pggenContext = {};
    ctx.trans = new Transaction();

    currentDomain.run(function() {
      _transactMiddle(gen, deferred, {
        domain: currentDomain,
        trans: ctx.trans,
        init: true
      });
    });

    return deferred.promise;
  };

  _transactMiddle = function(gen, deferred, ctx) {
    var trans = ctx.trans;
    var g = gen(trans);
    var next, abort;
    abort = function(e) {
      // rollback if this is the top-level transaction
      if (ctx.init) {
        trans.rollback().then(function() {
          // closing the transaction, so drop the current trans context
          if (!!domain.active) domain.active.__pggenContext = undefined;
          deferred.reject(e);
        });
      } else deferred.reject(e);
    };
    next = function(res) {
      if (res.done) {
        if (ctx.init) {
          trans.commit().then(function() {
            // closing the transaction, so drop the current trans context
            if (!!domain.active) domain.active.__pggenContext = undefined;
            deferred.resolve(res.value);
          });
        } else deferred.resolve(res.value);
      } else if (res.value && typeof res.value.then === 'function') {
        res.value.then(function(r) {
          try {
            next(g.next(r));
          } catch (e) {
            abort(e);
          }
        }, function(e) {
          abort(e);
        });
      } else {
        try {
          next(g.next(res.value));
        } catch (e) { abort(e); }
      }
    };
    next(g.next());
  };

  _setup = function(arg) {
    if (typeof arg === "string") {
      _conStr = arg;
    } else if (typeof arg === "object") {
      if (!!arg.string) {
        _conStr = arg.string;
      } else {
        _conStr = 'postgresql://';
        if (arg.user) {
          _conStr += arg.user;
          if (arg.password) _conStr += ':' + arg.password;
          _conStr += '@';
        }
        if (!!arg.host) _conStr += arg.host;
        else _conStr += 'localhost';
        if (!!arg.port) _conStr += ':' + arg.port;
        if (arg.db) _conStr += '/' + arg.db;
      }
      if (arg.hasOwnProperty('pool')) _pool = !!arg.pool;
      if (!!arg.log && typeof arg.log === 'function') _logFn = arg.log;
    }
  };

  Transaction = (function Transaction() {
    Transaction.displayName = 'Transaction';
    var prototype = Transaction.prototype, constructor = Transaction;

    prototype.close = function() {
      var deferred = when.defer();
      if (this.connection && this.closeOnDone) {
        if (_pool) this.whenDone();
        else this.connection.end();

        this.connection = null;
        this.active = false;
        this.done = true;
      }
      deferred.resolve(true);
      return deferred.promise;
    };

    prototype.begin = function() {
      if (this.done) {
        throw new Error("This transaction is already complete.");
      } else if (!this.active) {
        var t = this;
        return _connect().then(function(c) {
          t.connection = c[0];
          t.active = true;
          if (_pool) t.whenDone = c[1];
          return t.query('begin;').then(function() { return c; });
        });
      } else {
        var deferred = when.defer();
        deferred.resolve([this.connection]);
        return deferred.promise;
      }
    };

    prototype.commit = function() {
      if (this.done) {
        throw new Error("This transaction is already complete.");
      } else if (!this.active && !this.done) {
        var deferred = when.defer();
        deferred.resolve(true);
        this.done = true;
        return deferred.promise;
      } else {
        var t = this;
        return this.query('commit;').then(function() {
          t.successful = true;
          return t.close();
        }, function(err) {
          t.successful = false;
          return t.close().then(function() { throw err; });
        });
      }
    };

    prototype.rollback = function() {
      if (!this.active || this.done)
        throw new Error("This transaction is already complete.");
      else {
        var t = this;
        return this.query('rollback;').then(function() {
          t.successful = false;
          return t.close();
        }, function(err) {
          t.successful = false;
          return t.close().then(function() { throw err; });
        });
      }
    };

    prototype.query = function(query, params) {
      var t = this;
      if (!this.active) return this.begin().then(function() { return t.query(query, params); });
      else return _query(this.connection, query, params);
    };

    prototype.queryOne = function(query, params) {
      var t = this;
      if (!this.active) return this.begin().then(function() { return t.queryOne(query, params); });
      else return _queryOne(this.connection, query, params);
    };

    prototype.nonQuery = function(query, params) {
      var t = this;
      if (!this.active) return this.begin().then(function() { return t.nonQuery(query, params); });
      else return _nonQuery(this.connection, query, params);
    };

    prototype.active = false;
    prototype.done = false;
    prototype.closeOnDone = true;
    prototype.successful = false;
    prototype.whenDone = null;

    function Transaction() { this.__id = nextId(); }
    return Transaction;
  }());

  prototype.transaction = _transact;
  prototype.newTransaction = _newTransact;
  prototype.hasTransaction = _hasCurrent;
  prototype.currentTransaction = function() {
    if (_hasCurrent()) return domain.active.__pggenContext.trans;
    else return undefined;
  };
  prototype.query = function(query, params) {
    return _query(null, query, params);
  };
  prototype.queryOne = function(query, params) {
    return _queryOne(null, query, params);
  };
  prototype.nonQuery = function(query, params) {
    return _nonQuery(null, query, params);
  };
  prototype.log = function(fn) {
    if (!!fn && typeof fn === 'function') _logFn = fn;
  };
  prototype.connectionString = function() { return _conStr; };

  function DB(con) {
    if (!!!con) throw new Error("You must supply a connection configuration.");
    _setup(con);
  }
  return DB;
}());
