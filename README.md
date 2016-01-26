# postgres-gen

postgres-gen expects there to be a reasonable ES6 promise implementation available. It looks like the one available in node as of 0.11.13 does not work nicely with domains, so one should be provided. when.js is currently used in the test script, but any other implementation should work.

postgres-gen is a wrapper for pg or pg.js that facilitates the running PostgreSQL queries or transactions inside a generator using promises. There are a few scenarios in which this wrapper is particularly useful.

## 1. Using yield to execute a query or transaction inside another generator

All postgres-gen methods return a promise for the result of the query or transaction, so other flow-control generator libraries that handle promises, like koa, can handle the query appropriately.

```javascript
var pg = require('postgres-gen')('connection string or config object here');

myKoaApp.use(function*() {
  var records = (yield pg.query('select * from some_table;')).rows;
  this.send(records);
}
```

## 2. Using a generator to execute a transaction with proper failure handling

The transaction method takes a generator function and passes in a helper to execute queries that will be wrapped in a transaction. If any exceptions are thrown within the generator function or any promises that are yielded from within the generator are rejected, the transaction will be rolled back and the promise returned from the transaction method will be rejected with the error.

```javascript
var pg = require('postgres-gen')('connection string or config object here');

pg.transaction(function*(t) {
  yield t.query("drop table important_production_data;");
  var realization = (yield t.query("select 'what have I done?' as message;")).rows[0].message;
  throw new Error(realization);
  yield t.query("select 'I will not run';");
});
```

```javascript
pg.transaction(function*(t) {
  yield t.nonQuery('update accounts set balance = balance + $1;', [25]);
  var recordsAffected = yield t.nonQuery('update missing_table set non_existant_column = null;');
  var message = (yield t.queryOne("select 'you will never get to me' as message;")).message;
  return message;
});
```

It's important to note that any queries that are not yielded will be run in sequence due to the way the pg driver query queue works, but they will not cause the transaction to fail properly if there are any errors, as the transaction runner will have no knowledge of them. Any subsequent queries will cause the transaction to fully abort, since the server-side transaction will be failed. Having the last query in the transaction not participate in the transaction would have unfortunate consequences. Always yield!

## 3. Named parameters

Starting with 0.1.0, postgres-gen supports querying with named parameters in addition to positional parameters. If a parameters object is passed instead of a parameters array, the sql string may contain object keys as parameters. The named parameters will be converted to positional parameters before the query is passed on the the pg driver.

```javascript
pg.query('select * from arsenal where type = $type and yield > $kilotons;', { type: 'nuclear', kilotons: 2000 });
```

## 4. ? parameters

node-postgres requires positional parameters to be numbered with $s. Sometimes it's more convenient to have a simple ? in a query than numbering each one.

```javascript
pg.query('select count(*) from agency_complaints where initials = ?;', 'IRS');
```

## 5. Javascript arrays as parameters

postgres-gen query normalization will also recognize a javascript array parameter and turn it into a sql array with the same members within a query. The only place this will fall over is where an array is stored in a json column, which should be pretty rare, but can be worked around by JSON.stringify-ing the array before sending it as a parameter.

```javascript
pg.query('select * from cars where classification in ? and id > ?;', [['awesome', 'classic', 'really super fast'], 10]);
```

Results in:

```sql
select * from cars where classification in ($1, $3, $4) and id > $2;
```

Notice that array parameter is replaced with its first element with additional elements added to the end of the param references, so that this also works nicely with named and number parameters.

## 6. Transactional domains

Starting with 0.2.0 postgres-gen supports using domains as transactional containers. Further queries down the asynchronous 'call stack' will participate in an upstream transaction if there is one available. There is also a new method that allows you to create a separate transaction context while one is already available.

```javascript
function oob() {
  // if called from somewhere within a transaction block (and for the love of Pete, yield), I will merrily participate in your transaction
  return pg.nonQuery('delete from arsenal;');
}

pg.transaction(function*() { // we're deliberately ignoring the transaction that is passed in
  var friends = yield pg.query('select * from nations where wantToDisarm = $friends;', { friends: true }).then(function(rs) { return rs.rowCount; });
  if (friends > 10) yield oob();
  throw new Error('Actually, we have changed our minds. Screw you guys, we\'re taking our nukes and going home (to lob them at you later).');
});
```

Whether or not you have friendly nations, you will get to keep your arsenal.

```javascript
function oob() {
  return pg.newTransaction(function*() {
    yield pg.nonQuery('delete from arsenal;');
  });
});

pg.transaction(function*() {
  yield pg.query("select 'MAD is mad' as dogma;");
  yield oob();
  yield pg.query('select $message as regret;', { message: 'wait, I\'ve changed my mind!' });
  throw new Error('You can try to back out, but it\'s too late!');
});
```

Further ```transaction``` calls from within a transactional domain will also use the existing transaction. ```newTransaction``` must be called if you don't want to participate in any transaction that may already be ongoing. This can be used to create convenience DAOs for insert, update, etc that can be executed transactionally without requiring special parameter processing to pass the transaction.

## 7. Tagged template SQL

If you happen to be on an ES6 platform (or using a transpiler), you can use any query methods as tagged template handlers. Any interpolations will be turned into SQL parameters, unless they're a special literal, in which case they are inserted into the query string just like a non-tagged template.

```js
// in co or koa or some handy generator flow-control context
let name = 'foo', table = 'bar', age = 22;
let people = (yield pg.query`select * from ${pg.literal(table)} where name = ${name} and age > ${age}).rows;
```

In this example, the query is turned into:
```sql
select * from bar where name = $1 and age > $2
```
and the record array is assigned to the people variable.

## A note on connection pooling...

By default, all connections use the underlying pooling mechanism of `node-postgres`, which gives you a 10 connection pool with a 30 second idle timeout. That fits nicely with the single-threaded event loop of node from what I've seen. This means that there is no way to immediately close a connection while pooling is enabled, because the connection will just return to the pool. That's what it's there for, after all - to eliminate the connection setup/teardown. If you want to manage connection lifecycle closely, you can disable pooling. With pooling disabled, a single query will open a connection, run the query and close the connection. The same goes for a transactions e.g. when the transaction starts, the connection is opened, and when it completes, it is closed.

Starting with `0.9.0`, you can now drain and dispose the pool associated with an instance by using the new `close` method. You can also drain and dispose all of the pools by useing the new module `close` method.

```js
var pg = require('postgres-gen');

pg.pg; // this is the node-postgres module used by postgres-gen
pg.close(); // this closes all connections everywhere
// it returns a promise that resolves when the connections are closed

var con = pg({ my: 'connection details' });
con.pg; // also the node-postgres module used by postgres-gen
con.close(); // this closes all of the connections in this instance's connection pool (by connection string)
// it returns a promise that resolves when the connections in this particular pool are closed
```

Obviously, if there are no connections open (no queries have been run), both of these new methods will resolve immediately - or at least as immediately as a Promise can resolve.
