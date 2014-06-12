var should = require('should');
var mod = require('./');
var pg = mod({ host: 'localhost', db: 'postgres_gen_test', user: 'postgres_gen_test', password: 'postgres_gen_test' });
var norm = mod.normalizeQueryArguments;

var stmts = [];
pg.log(function(s) { stmts.push(s); });

describe('Transactions', function() {
  describe('when nested', function() {
    it('should share the same transaction instance by default', function(done) {
      pg.transaction(function*(t1) {
        yield pg.transaction(function*(t2) {
          yield t1.should.equal(t2);
        });
      }).finally(done);
    });

    it('should not share the same transaction instance when requested', function(done) {
      pg.transaction(function*(t1) {
        yield pg.newTransaction(function*(t2) {
          yield t1.should.not.equal(t2);
        });
      }).finally(done);
    });

    it('should happen within the same begin/commit block by default', function(done) {
      stmts = [];
      pg.transaction(function*() {
        yield pg.query('select 1;');
        yield pg.transaction(function*() {
          yield pg.query('select 2;');
        });
      }).then(function() {
        stmts.length.should.equal(4);
        stmts[0].query.should.match(/begin/i);
        stmts[3].query.should.match(/commit/i);
      }).then(function() { done(); }, done);
    });
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
});
