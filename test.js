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
      (function() { return norm(arguments); })('select ?, ?', 1).query.should.equal('select $1, $2');
    });
    it('should handle a params array', function() {
      (function() { return norm(arguments); })('select ?, ?', [1, 2]).params.should.eql([1, 2]);
    });
    it('should handle a params varargs', function() {
      (function() { return norm(arguments); })('select ?, ?', 1, 2).params.should.eql([1, 2]);
    });
    it('should allow an options object to appear at the end', function() {
      var obj = { 'foo': 1 };
      (function() { return norm(arguments); })('select ?, ?', 1, 2, obj).options.should.equal(obj);
      (function() { return norm(arguments); })('select ?, ?', [1, 2], obj).options.should.equal(obj);
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

  describe('when passed array parameters', function() {
    it('should split them into individual parameters', function() {
      var q = (function() { return norm(arguments); })('select ? in ?', [1, [1, 2, 3, 4]]);
      q.params.length.should.equal(5);
      q.query.should.equal('select $1 in ($2, $3, $4, $5)');
      q = (function() { return norm(arguments); })('select $a in $aa, $b, $c, $d, $e, $f, $g, $h, $i, $j, $k, $l, $m, $n, $o, $p, $q, $r, $s, $t, $u, $v, $w, $x, $y, $z', { a: 1, aa: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17, r: 18, s: 19, t: 20, u: 21, v: 22, w: 23, x: 24, y: 25, z: 26 });
      q.query.should.equal('select $1 in ($2, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27');
      q.params[27].should.equal(2);
      q.params[0].should.equal(1);
      q.params[1].should.equal(1);
      q.params[3].should.equal(3);
      q.params[26].should.equal(26);
      q.params[27].should.equal(2);
    });
    it('should be usable as queries', function(done) {
      var pg = mod(con1);
      pg.transaction(function*(t) {
        var r = (yield t.queryOne('select ? in ? as ok', [2, [1, 2, 3]])).ok;
        r.should.equal(true);
        r = (yield t.queryOne('select $value in $array as ok', { value: 10, array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 12, 13] })).ok;
        r.should.equal(false);
      }).then(done, done);
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
