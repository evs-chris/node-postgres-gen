var should = require('should');
var pg = require('./')({ host: 'localhost', db: 'postgres_gen_test', user: 'postgres_gen_test', password: 'postgres_gen_test' });

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
