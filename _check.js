const c = db.getSiblingDB('heartbeat').heartbeats;
print('type ' + db.getSiblingDB('heartbeat').getCollectionInfos({name:'heartbeats'})[0].type);
print('docs ' + c.countDocuments());
print('distinct ' + c.distinct('datetime').length);
