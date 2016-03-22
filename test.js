var should = require('should');
// need a working version of promises
global.Promise = require('when/es6-shim/Promise');
var mod = require('./');
var con1 = { host: 'localhost', db: 'postgres_gen_test', user: 'postgres_gen_test', password: 'postgres_gen_test' };
var con2 = { host: '127.0.0.1', db: 'postgres_gen_test', user: 'postgres_gen_test', password: 'postgres_gen_test' };
var norm = mod.normalizeQueryArguments;

function logger(s) { this.push(s); }

function isEmpty(o) {
  if (!o) return true;
  for (var k in o) {
    if (o.hasOwnProperty(k)) return false;
  }
  return true;
}

function go(connect1, connect2, domain) {
  describe('Transactions', function() {
    describe('when nested', function() {
      if (domain) {
        it('should share the same transaction instance by default', function(done) {
          var pg = connect1();
          pg.transaction(function*(t1) {
            yield pg.transaction(function*(t2) {
              yield t1.should.equal(t2);
            });
          }).then(done, done);
        });
      }

      it('should use the given transaction when supplied', function(done) {
        var pg = connect1();
        pg.transaction(function*(t1) {
          yield t1.query('select 1;');
          yield t1.transaction(function*(t2) {
            yield t2.query('select 2');
            t1.should.equal(t2);
          });
        }).then(done, done);
      });

      it('should not share the same transaction instance when requested', function(done) {
        var pg = connect1();
        pg.transaction(function*(t1) {
          yield pg.newTransaction(function*(t2) {
            yield t1.should.not.equal(t2);
          });
        }).then(done, done);
      });

      if (domain) {
        it('should happen within the same begin/commit block by default', function(done) {
          var stmts = [];
          var pg = connect1();
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
          var pg = connect1();
          var pg2 = connect2();
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
      }
    });

    it('should be rolled back if an error is thrown', function(done) {
      var stmts = [];
      var pg = connect1();
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
      var pg = connect1();
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
    describe('with apply-like calls', function() {
      var q = 'select $1, $2', opts = { foo: 1 }, nm = function() { return norm(arguments); };
      it('should handle simple arrays w/ opts', function() {
        var res = nm([q, 1, 2, opts]);
        res.query.should.equal(q);
        res.params.should.eql([1, 2]);
        res.options.foo.should.equal(1);
      });

      it('should handle simple arrays w/ no opts', function() {
        var res = nm([q, 1, 2]);
        res.query.should.equal(q);
        res.params.should.eql([1, 2]);
        should.ok(isEmpty(res.options));
      });

      it('should handle blank query and opts', function() {
        var res = nm(['', opts]);
        res.query.should.equal('');
        res.options.foo.should.equal(1);
      });

      it('should handle blank query and no opts', function() {
        var res = nm(['']);
        res.query.should.equal('');
        should.ok(isEmpty(res.options));
      });

      it('opts only', function() {
        var res = nm([opts]);
        res.query.should.equal('');
        res.options.foo.should.equal(1);
      });

      it('completely empty', function() {
        var res = nm([]);
        res.query.should.equal('');
        should.ok(isEmpty(res.options));
      });

      it('should handle params array w/ opts', function() {
        var res = nm([q, [1, 2], opts]);
        res.query.should.equal(q);
        res.params.should.eql([1, 2]);
        res.options.foo.should.equal(1);
      });

      it('should handle param array no opts', function() {
        var res = nm([q, [1, 2]]);
        res.query.should.equal(q);
        res.params.should.eql([1, 2]);
        should.ok(isEmpty(res.options));
      });

      it('should handle params array w/ internal opts', function() {
        var res = nm([q, [1, 2, opts]]);
        res.query.should.equal(q);
        res.params.should.eql([1, 2]);
        res.options.foo.should.equal(1);
      });
    });

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
      it('should handle two arrays', function() {
        var arr1 = [1, 2, 3], arr2 = [4, 5, 6];
        arr1.literalArray = true;
        arr2.literalArray = 2;
        var res = (function() { return norm(arguments); })('insert into some_table values 10, ?, ?;', [arr1, arr2]);
        res.query.should.equal('insert into some_table values 10, ARRAY[$1, $3, $4], ARRAY[$2, $5, $6];');
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
      it('should handle multiple long arrays without crapping out', function() {
        var arr1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,17, 18, 19, 20], arr2 = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40];
        arr1.literalArray = true;
        arr2.literalArray = true;
        var q = (function() { return norm(arguments); })('update foo, set bar = ?, baz = ?', [arr1, arr2]);
        console.log(JSON.stringify(q));
        q.query.should.equal('update foo, set bar = ARRAY[$1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21], baz = ARRAY[$2, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40]');
      });
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
        var pg = connect1();
        pg.transaction(function*(t) {
          var r = (yield t.queryOne('select ? in ? as ok', [2, [1, 2, 3]])).ok;
          r.should.equal(true);
          r = (yield t.queryOne('select $value in $array as ok', { value: 10, array: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 12, 13] })).ok;
          r.should.equal(false);
        }).then(done, done);
      });
      it('should not insert a phantom element into empty arrays', function() {
        var q = (function() { return norm(arguments); })('select ? in ?', [1, []]);
        q.query.should.equal('select $1 in (select 1 where false)');
        q.params.length.should.equal(1);
        q.params[0].should.equal(1);
        var lit = [];
        lit.literalArray = true;
        q = (function() { return norm(arguments); })('select ?::varchar[]', [lit]);
        q.query.should.equal('select ARRAY[]::varchar[]');
        q.params.length.should.equal(0);
        q = (function() { return norm(arguments); })('select $a in $aa, $b, $c, $d, $e, $f, $g, $h, $i, $j, $k, $l, $m, $n, $o, $p, $q, $r, $s, $t, $u, $v, $w, $x, $y, $z, $z1 in $z2', { a: 1, aa: [], b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17, r: 18, s: 19, t: 20, u: 21, v: 22, w: 23, x: 24, y: 25, z: 26, z1: 27, z2: [1, 2] });
        q.query.should.equal('select $1 in (select 1 where false), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27 in ($28, $29)');
        q.params.length.should.equal(29);
        q.params[25].should.equal(26);
        q.params[28].should.equal(2);
        q = (function() { return norm(arguments); })('update foo set arr = ? where foo = ? and bar = ?', [lit, '5', 22]);
        q.query.should.equal('update foo set arr = ARRAY[] where foo = $1 and bar = $2');
        q.params.length.should.equal(2);
      });
    });
  });

  describe('Multiple connections', function() {
    it('should be kept separate', function() {
      var pg = connect1();
      var pg2 = connect2();
      pg.connectionString().should.not.eql(pg2.connectionString());
    });
  });

  describe('Query methods should be usable as template tags', function() {
    function n() { return norm(arguments); }
    var pg = connect1();

    it('with plain normalization', function() {
      var bar = 'baz';
      var q = n`select foo from bar where baz = ${bar}`;
      q.params.length.should.equal(1);
      q.query.should.equal('select foo from bar where baz = $1');
      q.params[0].should.equal(bar);
    });

    it('with query', function(done) {
      var foo = 'test';
      pg.query`select ${foo}::varchar as foo`.then(function(r) { r.rows[0].foo.should.equal(foo); }).then(done, done);
    });

    it('with queryOne', function(done) {
      var foo = 'test';
      pg.queryOne`select ${foo}::varchar as foo`.then(function(r) { r.foo.should.equal(foo); }).then(done, done);
    });

    it('and support literal interpolation too', function() {
      var foo = 'test', bar = 'bippy';
      var q = n`select * from ${pg.lit(foo)} where bar = ${bar} and baz = ${pg.lit('true')} and name = ${foo}`;
      q.params.length.should.equal(2);
      q.query.should.equal('select * from test where bar = $1 and baz = true and name = $2');
      q.params[0].should.equal(bar);
      q.params[1].should.equal(foo);
    });
  });
}

describe('With domains', function() { go(function() { return mod(con1); }, function() { return mod(con2); }, true); });
describe('Without domains', function() { go(function() { return mod(con1, { domains: false }); }, function() { return mod(con2, { domains: false }); }, false); });

describe('Closing connections', function() {
  var con = mod(con1);
  it('should close pooled connections per instance', function(done) {
    var result = Promise.all([
      con.queryOne('select 1;'),
      con.queryOne('select 2;')
    ]);

    var pool;

    result.then(function() {
      var start = +(new Date());

      pool = con.pg.pools.all[JSON.stringify(con.connectionString())];
      pool.getPoolSize().should.equal(2);

      con.transaction(function*(t) {
        var res = yield t.queryOne('select 3;');
        yield new Promise(function(ok) {
          setTimeout(ok, 1000);
        });
        return res;
      });

      return new Promise(function(ok, fail) {
        setTimeout(function() {
          return con.close().then(ok, fail);
        }, 100);
      }).then(function() {
        (+(new Date()) - start).should.be.greaterThan(500);
        should.equal(con.pg.pools.all[JSON.stringify(con.connectionString())], undefined);
        pool.getPoolSize().should.equal(0);
      });
    }).then(done, done);
  });

  it('should close all pooled connections as a passthru', function(done) {
    var start = +(new Date());

    con.transaction(function*(t) {
      yield t.queryOne('select 1;');
      yield new Promise(function(ok) {
        setTimeout(ok, 500);
      });
    });

    return new Promise(function(ok, fail) {
      setTimeout(function() {
        return mod.close().then(ok, fail);
      }, 100);
    }).then(function() {
      (+(new Date()) - start).should.be.greaterThan(500);
    }).then(done, done);
  });
});
