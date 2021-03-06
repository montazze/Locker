/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/
var logger;
var lutil = require("lutil");
var crypto = require("crypto");
var async = require('async');
var lmongoutil = require("lmongoutil");
var lsql = require('sqlite-cursor');


var itemCol, respCol;
var locker;
var mItem, mResp, mKey;


exports.init = function(iCollection, rCollection, l, callback) {
    locker = l;
    logger = l.logger;
    itemCol = iCollection;
    itemCol.ensureIndex({"id":1},{unique:true, background:true},function() {});
    itemCol.ensureIndex({"keys":1},{background:true},function() {});
    respCol = rCollection;
    respCol.ensureIndex({"id":1},{unique:true, background:true},function() {});
    respCol.ensureIndex({"item":1},{background:true},function() {});
    async.series([
        function(cb) {
            lsql.connectToDB("./timeline.sqlite", cb);
        },
        function(cb) {
            mKey = new lsql.Model("key", {
                key:{type:lsql.Types.String, primaryKey:true},
                item:lsql.Types.String
            });
            console.error()
            mKey.create(cb);
        },
        function(cb) {
            mItem = new lsql.Model("item", {
                item:{type:lsql.Types.String, primaryKey:true},
                json:lsql.Types.String
            });
            mItem.create(cb);
        },
        function(cb) {
            mResp = new lsql.Model("response", {
                item:{type:lsql.Types.String},
                json:lsql.Types.String
            });
            mResp.create(cb);
        }], callback);
}

exports.clear = function(callback) {
    itemCol.drop(function(){respCol.drop(callback)});
}

exports.getTotalItems = function(callback) {
    itemCol.count(callback);
}
exports.getTotalResponses = function(callback) {
    respCol.count(callback);
}

exports.getAll = function(fields, callback) {
    itemCol.find({}, fields, callback);
}

exports.getLastObjectID = function(cbDone) {
    itemCol.find({}, {fields:{_id:1}, limit:1, sort:{_id:-1}}).nextObject(cbDone);
}

exports.getItemByKey = function(key, callback) {
    var item;
    var kname = "keys."+key;
    var find = {};
    find[kname] = {$exists:true};
    findWrap(find,{limit:1},itemCol,function(i){item=i},function(err){callback(err,item)});
}

exports.getItem = function(id, callback) {
    var item;
    findWrap({id:id},{},itemCol,function(i){item=i},function(err){callback(err,item)});
}

// arg takes sort/limit/offset/find
exports.getResponses = function(arg, cbEach, cbDone) {
    var f = (arg.item)?{item:arg.item}:{};
    delete arg.item;
    if(arg.from) f["from.id"] = arg.from;
    findWrap(f,arg,respCol,cbEach,cbDone);
}

exports.getSince = function(arg, cbEach, cbDone) {
    if(!arg || !arg.id) return cbDone("no id given");
    findWrap({"_id":{"$gt":lmongoutil.ObjectID(arg.id)}}, {sort:{_id:-1}}, itemCol, cbEach, cbDone);
}

// arg takes sort/limit/offset/find
exports.getItems = function(arg, cbEach, cbDone) {
    var f = {};
    try {
        if(arg.find) f = JSON.parse(arg.find); // optional, can bomb out
    }catch(E){
        return cbDone("couldn't parse find");
    }
    delete arg.find;
    if(arg.from) f["froms."+arg.from] = {$exists:true};
    findWrap(f,arg,itemCol,cbEach,cbDone);
}

function findWrap(a,b,c,cbEach,cbDone){
//    console.log("a(" + JSON.stringify(a) + ") b("+ JSON.stringify(b) + ")");
    var cursor = c.find(a);
    if (b.sort) cursor.sort(parseInt(b.sort));
    if (b.limit) cursor.limit(parseInt(b.limit));
    if (b.offset) cursor.skip(parseInt(b.offset));
    cursor.each(function(err, item) {
        if (item != null) {
            cbEach(item);
        } else {
            cbDone(err);
        }
    });
}


// insert new (fully normalized) item, generate the id here and now
exports.addItem = function(item, callback) {
    var etype = "update";
    if(!item.id)
    { // first time an item comes in, make a unique id for it
        var hash = crypto.createHash('md5');
        for(var i in item.keys) hash.update(i);
        item.id = hash.digest('hex');
        etype = "new";
    }
    var responses = item.responses;
    if(responses) responses.forEach(function(r){ r.item = item.id; });
    delete item.responses; // store responses in their own table
    delete item._id; // mongo is miss pissypants
    itemCol.findAndModify({"id":item.id}, [['_id','asc']], {$set:item}, {safe:true, upsert:true, new: true}, function(err, doc){
        if(locker) locker.ievent(lutil.idrNew("item","timeline",doc.id),doc,etype); // let happen independently
        if(err || !responses) return callback(err, doc);
        async.forEach(responses, exports.addResponse, function(err){callback(err, doc);}); // orig caller wants saved item back
    });
}

// responses are unique by their contents
exports.addResponse = function(response, callback) {
    delete response.id;
    delete response._id; // mongo is miss pissypants
    var item = response.item;
    delete response.item;
    var hash = crypto.createHash('md5');
    hash.update(JSON.stringify(response));
    response.item = item;
    response.id = hash.digest('hex');
    respCol.findAndModify({"id":response.id}, [['_id','asc']], {$set:response}, {safe:true, upsert:true, new: true}, callback);
}

// so, yeah, and that
exports.delItem = function(id, callback) {
    if(!id || id.length < 10) return callback("no or invalid id to del: "+id);
    itemCol.remove({id:id}, function(err){
        if(err) return callback(err);
        if(locker) locker.ievent(lutil.idrNew("item","timeline",doc.id),doc,"delete"); // let happen independently
        respCol.remove({item:id}, callback);
    });
}
