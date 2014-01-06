var pg;
try {
	pg = require('pg');
} catch (e) {
	try {
		pg = require('pg.js');
	} catch (e) {
		console.log(e);
		throw new Error("Could not access pg module. Please install either pg or pg.js.");
	}
}

var when = require('when');

var DB, __logFn = null;

module.exports = function(con) { return new DB(con); };
module.exports.log = function(fn) {
	if (!!fn && typeof fn === 'function') __logFn = fn;
}

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
	}

	_query = function(connection, query, params) {
		var con;
		if (!!connection) {
			var p = when.defer();
			con = p.promise;
			p.resolve([connection]);
		} else {
			con = _connect();
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
				if (!!!connection) {
					if (_pool) c[1]();
					else c[0].end();
				}
			});
			return deferred.promise;
		});
	}

	_nonQuery = function(connection, query, params) {
		return _query(connection, query, params).then(function(res) {
			return res.rowCount;
		});
	}

	_queryOne = function(connection, query, params) {
		return _query(connection, query, params).then(function(res) {
			if (res.rows.length > 0) {
				return res.rows[0];
			} else {
				throw new Error("No rows were returned where at least one was expected.");
			}
		});
	}

	_transact = function(gen) {
		var trans = new Transaction();
		var g = gen(trans);
		var deferred = when.defer();
		var next, abort;
		abort = function(e) {
			trans.rollback().then(function() {
				deferred.reject(e);
			});
		}
		next = function(res) {
			if (res.done) {
				var t = trans.commit();
				t.then(function() { deferred.resolve(res.value); });
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
		}
		next(g.next());
		return deferred.promise;
	}

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
				if (arg.db) _conStr += '/' + arg.db
			}
			if (arg.hasOwnProperty('pool')) _pool = !!arg.pool;
			if (!!arg.log && typeof arg.log === 'function') _logFn = arg.log;
		}
	}

	Transaction = (function() {
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
		}

		prototype.begin = function() {
			if (this.done) {
				throw new Error("This transaction is already complete.");
			} else if (!this.active) {
				var t = this;
				return _connect().then(function(c) {
					t.connection = c[0];
					t.active = true;
					if (_pool) t.whenDone = c[1];
					return t.query('begin;');
				});
			}
		}

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
				});
			}
		}

		prototype.rollback = function() {
			if (!this.active || this.done)
				throw new Error("This transaction is already complete.");
			else {
				var t = this;
				return this.query('rollback;').then(function() {
					t.successful = false;
					return t.close();
				});
			}
		}

		prototype.query = function(query, params) {
			var t = this;
			if (!this.active) return this.begin().then(function() { return t.query(query, params); });
			else return _query(this.connection, query, params);
		}

		prototype.queryOne = function(query, params) {
			var t = this;
			if (!this.active) return this.begin().then(function() { return t.queryOne(query, params); });
			else return _queryOne(this.connection, query, params);
		}

		prototype.nonQuery = function(query, params) {
			var t = this;
			if (!this.active) return this.begin().then(function() { return t.nonQuery(query, params); });
			else return _nonQuery(this.connection, query, params);
		}

		prototype.active = false;
		prototype.done = false;
		prototype.closeOnDone = true;
		prototype.successful = false;
		prototype.whenDone = null;

		function Transaction() {}
		return Transaction;
	}());

	prototype.transaction = _transact;
	prototype.query = function(query, params) {
		return _query(null, query, params);
	}
	prototype.queryOne = function(query, params) {
		return _queryOne(null, query, params);
	}
	prototype.nonQuery = function(query, params) {
		return _nonQuery(null, query, params);
	}
	prototype.log = function(fn) {
		if (!!fn && typeof fn === 'function') _logFn = fn;
	}

	function DB(con) {
		if (!!!con) throw new Error("You must supply a connection configuration.");
		_setup(con);
	}
	return DB;
}());
