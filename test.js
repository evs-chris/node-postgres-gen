var should = require('should');
// need a working version of promises
global.Promise = require('when/es6-shim/Promise');
var mod = require('./');
var con1 = { host: 'localhost', db: 'postgres_gen_test', user: 'postgres_gen_test', password: 'postgres_gen_test' };
var con2 = { host: '127.0.0.1', db: 'postgres_gen_test', user: 'postgres_gen_test', password: 'postgres_gen_test' };
var norm = mod.normalizeQueryArguments;

function logger(s) { this.push(s); }

// --jshint, please skip should magic
if (should) ;

describe('Transactions', function() {
  describe('when nested', function() {
    it('should share the same transaction instance by default', function(done) {
      var pg = mod(con1);
      pg.transaction(function*(t1) {
        yield pg.transaction(function*(t2) {
          yield t1.should.equal(t2);
        });
      }).then(done, done);
    });

    it('should not share the same transaction instance when requested', function(done) {
      var pg = mod(con1);
      pg.transaction(function*(t1) {
        yield pg.newTransaction(function*(t2) {
          yield t1.should.not.equal(t2);
        });
      }).then(done, done);
    });

    it('should happen within the same begin/commit block by default', function(done) {
      var stmts = [];
      var pg = mod(con1);
      pg.log(logger.bind(stmts));
      pg.transaction(function*() {
        yield pg.query('select 1;');
        yield pg.transaction(function*() {
          yield pg.query('select 2;');
        });
      }).then(function() {
        stmts.length.should.equal(4);
        stmts[0].query.should.match(/begin/i);
        stmts[3].query.should.match(/commit/i);
        done();
      }).catch(done);
    });

    it('should use the correct db if there is more than one available', function(done) {
      var pg = mod(con1);
      var pg2 = mod(con2);
      pg.transaction(function*(t1)  {
        yield pg2.transaction(function*(t2) {
          yield t1.should.not.equal(t2);
          yield pg.transaction(function*(t3) {
            yield t1.should.equal(t3);
            yield pg2.transaction(function*(t4) {
              yield t2.should.equal(t4);
            });
          });
        });
      }).then(done, done);
    });
  });

  it('should be rolled back if an error is thrown', function(done) {
    var stmts = [];
    var pg = mod(con1);
    pg.log(logger.bind(stmts));
    pg.transaction(function*(t) {
      var n = (yield t.queryOne('select 1::integer as num;')).num;
      n.should.equal(1);
      throw new Error('Nevermind');
    }).then(done, function(e) {
      e.message.should.eql('Nevermind');
      stmts.length.should.equal(3);
      stmts[0].query.should.match(/begin/i);
      stmts[1].query.should.match(/select 1/i);
      stmts[2].query.should.match(/rollback/i);
      done();
    }).catch(done);
  });

  it('should be committed at the end if successful', function(done) {
    var stmts = [];
    var pg = mod(con1);
    pg.log(logger.bind(stmts));
    pg.transaction(function*(t) {
      var n = (yield t.queryOne('select 1::integer as num;')).num;
      n.should.equal(1);
      n = (yield t.queryOne('select 2::varchar as str;')).str;
      n.should.equal('2');
    }).then(function() {
      stmts.length.should.equal(4);
      stmts[3].query.should.match(/commit/i);
      done();
    }).catch(done);
  });
});

describe('Query strings', function() {
  describe('containing ? params', function() {
    it('should convert to $# params', function() {
      (function() { return norm(arguments); })('select ?', 1).query.should.equal('select $1');
    });
    it('should handle a params array', function() {
      (function() { return norm(arguments); })('select ?', [1]).params.should.eql([1]);
    });
    it('should handle a params varargs', function() {
      (function() { return norm(arguments); })('select ?', 1).params.should.eql([1]);
    });
    it('should allow an options object to appear at the end', function() {
      var obj = { 'foo': 1 };
      (function() { return norm(arguments); })('select ?', 1, obj).options.should.equal(obj);
      (function() { return norm(arguments); })('select ?', [1], obj).options.should.equal(obj);
    });
  });

  describe('containing $alpha params', function() {
    it('should convert to $# params', function() {
      (function() { return norm(arguments); })('select $foo', { foo: 1 }).query.should.equal('select $1');
    });
    it('should handle a params object', function() {
      (function() { return norm(arguments); })('select $foo', { foo: 1 }).params.should.eql([1]);
    });
    it('should allow an options object to appear at the end', function() {
      var obj = { 'foo': 1 };
      (function() { return norm(arguments); })('select $foo', { foo: 1 }, obj).options.should.equal(obj);
    });
  });

  describe('passed as pre-normalized objects', function() {
    it('should be returned unharmed', function() {
      var q = { query: 'select 1', params: [] };
      (function() { return norm(arguments); })(q).should.equal(q);
    });
  });
});

describe('Multiple connections', function() {
  it('should be kept separate', function() {
    var pg = mod(con1);
    var pg2 = mod(con2);
    pg.connectionString().should.not.eql(pg2.connectionString());
  });
});
