# postgres-gen

postgres-gen is a wrapper for pg or pg.js that facilitates the running PostgreSQL queries or transactions inside a generator using promises. There are two scenarios in which this is particularly useful.

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
