# Sharding Internals

## Recommended prerequisite reading

A reader should be familiar with the
[**general concept**](https://docs.mongodb.com/manual/sharding/#sharding)
of horizontal scaling or "sharding", the
[**architecture of a MongoDB sharded cluster**](https://docs.mongodb.com/manual/sharding/#sharded-cluster),
and the concept of a
[**shard key in MongoDB**](https://docs.mongodb.com/manual/sharding/#shard-keys).

---

# Routing

There is an authoritative routing table stored on the config server replica set, and all nodes cache
the routing table in memory so that they can route requests to the shard(s) that own the
corresponding data.

## The authoritative routing table

The authoritative routing table is stored in a set of unsharded collections in the config database
on the config server replica set. The schemas of the relevant collections are:

* [**config.databases**](https://docs.mongodb.com/manual/reference/config-database/#config.databases)
* [**config.collections**](https://docs.mongodb.com/manual/reference/config-database/#config.collections)
* [**config.chunks**](https://docs.mongodb.com/manual/reference/config-database/#config.chunks)
* [**config.shards**](https://docs.mongodb.com/manual/reference/config-database/#config.shards)

#### Code references

* The
[**indexes created**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/sharding_catalog_manager.cpp#L295-L372)
on each of these collections for efficient querying

## The routing table cache

## Shard versioning and database versioning

In a sharded cluster, the placement of collections is determined by a versioning protocol. We use
this versioning protocol in tracking the location of both chunks for sharded collections and
databases for unsharded collections.

### Shard versioning

The shard versioning protocol tracks the placement of chunks for sharded collections.

Each chunk has a version called the "chunk version." A chunk version consists of three elements:

1. The major version - an integer incremented when a chunk moves shards.
1. The minor version - an integer incremented when a chunk is split.
1. The epoch - an object ID shared among all chunks for a collection that distinguishes a unique instance of the collection. The epoch remains unchanged for the lifetime of the chunk, unless the collection is dropped or the collection's shard key has been refined using the refineCollectionShardKey command.

To completely define the shard versioning protocol, we introduce two extra terms - the "shard
version" and "collection version."

1. Shard version - For a sharded collection, this is the highest chunk version seen on a particular shard.
1. Collection version - For a sharded collection, this is the highest chunk version seen across all shards.

### Database versioning

The database versioning protocol tracks the placement of databases for unsharded collections. The
“database version” indicates on which shard a database currently exists. A database version
consists of two elements:

1. The UUID - a unique identifier to distinguish different instances of the database. The UUID remains unchanged for the lifetime of the database, unless the database is dropped and recreated.
1. The last modified field - an integer incremented when the database changes its primary shard.

### Versioning updates

Nodes that track chunk/database versions “lazily” load versioning information. A router or shard
will only find out that its internally-stored versioning information is stale via receiving changed
version information from another node.

For each request sent from an origin node to a remote node, the origin node will attach its cached
version information for the corresponding chunk or database. There are two possible versioning
scenarios: 

1. If the remote node detects a shard version mismatch, the remote node will return a message to the origin node stating as such. Whichever node that reports having an older version will attempt to refresh. The origin node will then retry the request.
1. If the remote node and the origin node have the same version, the request will proceed.

### Types of operations that will cause the versioning information to become stale

Operation Type                            | Version Modification Behavior                                                                                             |
--------------                            | -----------------------------                                                                                             |
Moving a chunk                            | Incremements the chunk's major version                                                                                    |
Splitting a chunk                         | If the shard version is equal to the collection version, increases the major version; always increments the minor version |
Merging a chunk                           | Sets the chunk's major version to the collection version plus one; will set the chunk's minor version to zero             |
Dropping a collection                     | Sets the chunk's version and epoch to the unsharded constant defined below                                                |
Refining a collection’s shard key         | Creates a new epoch while maintaining the chunk’s major and minor version                                                 |
Changing the primary shard for a database | Increments the database’s last modified field                                                                             |
Dropping a database                       | Creates a new UUID and set the last modified field to one                                                                 |

Refer to [SERVER-41480](https://jira.mongodb.org/browse/SERVER-41480) for the reasoning behind the
complicated behavior with splitting a chunk.

### Special versioning conventions

Chunk versioning conventions

Convention Type                           | Major Version | Minor Version | Epoch        |
---------------                           | ------------- | ------------- | -----        |
First chunk for sharded collection        | 1             | 0             | ObjectId()   |
Collection is unsharded                   | 0             | 0             | ObjectId()   |
Collection was dropped                    | 0             | 0             | ObjectId()   |
Ignore the chunk version for this request | 0             | 0             | Max DateTime |

Database version conventions

Convention Type | UUID   | Last Modified | 
--------------- | ----   | ------------- |
New database    | UUID() | 1             |
Config database | UUID() | 0             |
Admin database  | UUID() | 0             |

#### Code references

* [The chunk version class](https://github.com/mongodb/mongo/blob/master/src/mongo/s/chunk_version.h)
* [The database version IDL](https://github.com/mongodb/mongo/blob/master/src/mongo/s/database_version.idl)
* [The database version helpers class](https://github.com/mongodb/mongo/blob/master/src/mongo/s/database_version_helpers.h)
* [Where shard versions are stored in a routing table cache](https://github.com/mongodb/mongo/blob/1df41757d5d1e04c51eeeee786a17b005e025b93/src/mongo/s/catalog_cache.h#L499-L500)
* [Where database versions are stored in a routing table cache](https://github.com/mongodb/mongo/blob/1df41757d5d1e04c51eeeee786a17b005e025b93/src/mongo/s/catalog_cache.h#L497-L498)
* [Method used to attach the shard version to outbound requests](https://github.com/mongodb/mongo/blob/1df41757d5d1e04c51eeeee786a17b005e025b93/src/mongo/s/cluster_commands_helpers.h#L118-L121)
* [Where shard versions are parsed in the ServiceEntryPoint and put on the OperationShardingState](https://github.com/mongodb/mongo/blob/1df41757d5d1e04c51eeeee786a17b005e025b93/src/mongo/db/service_entry_point_common.cpp#L1136-L1150)
* [Where shard versions are stored in a shard's filtering cache](https://github.com/mongodb/mongo/blob/554ec671f7acb6a4df62664f80f68ec3a85bccac/src/mongo/db/s/collection_sharding_runtime.h#L249-L253)
* [The method that checks the equality of a shard version on a shard](https://github.com/mongodb/mongo/blob/554ec671f7acb6a4df62664f80f68ec3a85bccac/src/mongo/db/s/collection_sharding_state.h#L126-L131)
* [The method that checks the equality of a database version on a shard](https://github.com/mongodb/mongo/blob/554ec671f7acb6a4df62664f80f68ec3a85bccac/src/mongo/db/s/database_sharding_state.h#L98-L103)

## The shards list cache

## Targeting a specific host within a shard
When routing a query to a replica set, a cluster node must determine which member to target for a given read preference. A cluster node either has or creates a ReplicaSetMonitor for each remote shard to which it needs to route requests. Information from the ReplicaSetMonitor interface is used to route requests to a specific node within a shard.

Further details on replica set monitoring and host targeting can be found [here](../../../mongo/client/README.md).
---

# Migrations

Data is migrated from one shard to another at the granularity of a single chunk.

It is also possible to move unsharded collections as a group by changing the primary shard of a
database. This uses a protocol similar to but less robust than the one for moving a chunk, so only
moving a chunk is discussed here.

## The live migration protocol
A chunk is moved from one shard to another by the moveChunk command. This command can be issued either manually or by the balancer. The live migration protocol consists of an exchange of messages between two shards, the donor and the recipient. This exchange is orchestrated by the donor shard in the [moveChunk command](https://github.com/mongodb/mongo/blob/3f849d508692c038afb643b1acb99b8a8cb98d38/src/mongo/db/s/move_chunk_command.cpp#L214) which follows a series of steps.

1. **Start the migration** - The ActiveMigrationsRegistry is [updated on the donor side](https://github.com/mongodb/mongo/blob/3f849d508692c038afb643b1acb99b8a8cb98d38/src/mongo/db/s/move_chunk_command.cpp#L138) to reflect that a specific chunk is being moved. This prevents any other chunk migrations from happening on this shard until the migration is completed. If an existing incoming or outgoing migration is in flight then the registration will fail and the migration will be aborted. If the inflight operation is for the same chunk then the the registration call will return an object that the moveChunk command can use to join the current operation.
1. **Start cloning the chunk** - After validating the migration parameters, the donor starts the migration process by sending the _recvChunkStart message to the recipient. This causes the recipient to then [initiate the transfer of documents](https://github.com/mongodb/mongo/blob/5c72483523561c0331769abc3250cf623817883f/src/mongo/db/s/migration_destination_manager.cpp#L955) from the donor. The initial transfer of documents is done by [repeatedly sending the _migrateClone command to the donor](https://github.com/mongodb/mongo/blob/5c72483523561c0331769abc3250cf623817883f/src/mongo/db/s/migration_destination_manager.cpp#L1042) and inserting the fetched documents on the recipient.
1. **Transfer queued modifications** - Once the initial batch of documents are copied, the recipient then needs to retrieve any modifications that have been queued up on the donor. This is done by  [repeatedly sending the _transferMods command to the donor](https://github.com/mongodb/mongo/blob/5c72483523561c0331769abc3250cf623817883f/src/mongo/db/s/migration_destination_manager.cpp#L1060-L1111). These are [inserts, updates and deletes](https://github.com/mongodb/mongo/blob/11eddfac181ff6ff9faf3e1d55c050373bc6fc24/src/mongo/db/s/migration_chunk_cloner_source_legacy.cpp#L534-L550) that occurred on the donor while the initial batch was being transferred.
1. **Wait for recipient to clone documents** - The donor [polls the recipient](https://github.com/mongodb/mongo/blob/3f849d508692c038afb643b1acb99b8a8cb98d38/src/mongo/db/s/migration_chunk_cloner_source_legacy.cpp#L984) to see when the transfer of documents has been completed or the timeout has been exceeded. This is indicated when the recipient returns a state of “steady” as a result of the _recvChunkStatus command.
1. **Enter the critical section** - Once the recipient has cloned the initial documents, the donor then [declares that it is in a critical section](https://github.com/mongodb/mongo/blob/3f849d508692c038afb643b1acb99b8a8cb98d38/src/mongo/db/s/migration_source_manager.cpp#L344). This indicates that the next operations must not be interrupted and will require recovery actions if they are interrupted. Writes to the donor shard will be suspended while the critical section is in effect. The mechanism to implement the critical section writes the ShardingStateRecovery document to store the minimum optime of the sharding config metadata. If this document exists on stepup it is used to update the optime so that the correct metadata is used.
1. **Commit on the recipient** - While in the critical section, the [_recvChunkCommit](https://github.com/mongodb/mongo/blob/3f849d508692c038afb643b1acb99b8a8cb98d38/src/mongo/db/s/migration_chunk_cloner_source_legacy.cpp#L360) command is sent to the recipient directing it to fetch any remaining documents for this chunk. The recipient responds by sending _transferMods to fetch the remaining documents while writes are blocked on the donor. Once the documents are transferred successfully, the _recvChunkCommit command returns it’s status to unblock the donor.
1. **Commit on the config server** - The donor sends the _configsvrCommitChunkMigration command to the config server. Before the command is sent, [reads are also suspended](https://github.com/mongodb/mongo/blob/3f849d508692c038afb643b1acb99b8a8cb98d38/src/mongo/db/s/migration_source_manager.cpp#L436) on the donor shard.

#### Code references
* [ActiveMigrationRegistry](https://github.com/mongodb/mongo/blob/9be1041342b666e979aaea483c2fdb929c801796/src/mongo/db/s/active_migrations_registry.h#L52) class
* [MigrationSourceManager](https://github.com/mongodb/mongo/blob/2c87953010c2c1ec2d39dc9a7dbbd5f7d49dab10/src/mongo/db/s/migration_source_manager.h#L70) class
* [MigrationDestinationManager](https://github.com/mongodb/mongo/blob/2c87953010c2c1ec2d39dc9a7dbbd5f7d49dab10/src/mongo/db/s/migration_destination_manager.h#L71) class
* [MigrationChunkClonerSourceLegacy](https://github.com/mongodb/mongo/blob/11eddfac181ff6ff9faf3e1d55c050373bc6fc24/src/mongo/db/s/migration_chunk_cloner_source_legacy.h#L82) class
* [ShardingStateRecovery](https://github.com/mongodb/mongo/blob/2c87953010c2c1ec2d39dc9a7dbbd5f7d49dab10/src/mongo/db/s/sharding_state_recovery.h#L47) class

## Orphaned range deletion
After the migration protocol moves a chunk from one shard to another, the documents that were in the moved range need to be deleted from the donor shard. If the migration failed for any reason and was aborted, then any documents that have been copied over to the recipient need to be deleted. These documents are called orphans since they're not owned by the shard they reside on.

The migration protocol handles orphaned range deletion by recording the range that is being moved into the config.rangeDeletions collection on both the donor and recipient shards. The range deletion document contains the range that is to be deleted along with a pending flag that indicates if the range is ready for deletion.

If the migration completes successfully, the range is submitted for deletion on the donor and the range deletion document is deleted from the config.rangeDeletions collection on the recipient. If the migration fails, the range deletion document is deleted from the donor and the range is submitted for deletion on the recipient.

This sequence of steps is orchestrated by the MigrationCoordinator:
1. The donor shard writes the [migration coordinator document](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/migration_coordinator_document.idl#L67-L102) to its local
config.migrationCoordinators collection. This document contains a unique ID along with other fields that are needed to recover the migration upon failure.
1. The donor shard writes the [range deletion document](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/range_deletion_task.idl#L50-L76) to its local config.rangeDeletions collection with the pending flag set to true. This will prevent the range from being deleted until it is marked as ready.
1. Before the recipient shard begins migrating documents from the donor, if there is an overlapping range already in the config.rangeDeletions collection, the recipient will [wait for it to be deleted](https://github.com/mongodb/mongo/blob/ea576519e5c3445bf11aa7f880aedbee1501010c/src/mongo/db/s/migration_destination_manager.cpp#L865-L885). The recipient then [writes a range deletion document](https://github.com/mongodb/mongo/blob/ea576519e5c3445bf11aa7f880aedbee1501010c/src/mongo/db/s/migration_destination_manager.cpp#L895) to its local config.rangeDeletions collection before the clone step begins.
1. Once the migration is completed, the MigrationCoordinator records the decision in the migration coordinator document on the donor. 
    * If the migration succeeded, then the commit sequence is executed. This involves [deleting the range deletion document on the recipient](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/migration_coordinator.cpp#L204) and then [marking the range](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/migration_coordinator.cpp#L211) as ready to be deleted on the donor. The range is then [submitted for deletion](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/migration_coordinator.cpp#L225) on the donor.
    * If the migration failed, then the abort sequence is executed. This involves [deleting the range deletion task on the donor](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/migration_coordinator.cpp#L255) and then [marking the range as ready](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/migration_coordinator.cpp#L261) to be deleted on the recipient. The range is then [submitted for deletion](https://github.com/mongodb/mongo/blob/52a73692175cad37f942ff5e6f3d70aacbbb113d/src/mongo/db/s/shard_server_op_observer.cpp#L383-L393) on the recipient by the ShardServerOpObserver when the [write is committed]((https://github.com/mongodb/mongo/blob/52a73692175cad37f942ff5e6f3d70aacbbb113d/src/mongo/db/s/shard_server_op_observer.cpp#L131)).
1. The migration coordinator document is then [deleted](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/migration_coordinator.cpp#L270).

On either donor or recipient, the range deletion is [submitted asynchronously](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/range_deletion_util.cpp#L396) to a separate executor that maintains one thread. On the donor, there is a risk of deleting documents that are being accessed in ongoing queries. We first wait for any queries on the primary to complete by [waiting on a promise](https://github.com/mongodb/mongo/blob/52a73692175cad37f942ff5e6f3d70aacbbb113d/src/mongo/db/s/metadata_manager.h#L212-L221) that is signalled by the [reference counting mechanism](https://github.com/mongodb/mongo/blob/ab21bf5ef46689cf4503a3b089def71113c437e2/src/mongo/db/s/metadata_manager.cpp#L126) in RangePreserver and [CollectionMetadataTracker](https://github.com/mongodb/mongo/blob/52a73692175cad37f942ff5e6f3d70aacbbb113d/src/mongo/db/s/metadata_manager.h#L201). We then [wait for a specified amount of time](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/range_deletion_util.cpp#L417-L418) for any queries running on secondaries to complete before starting the deletion. The delay defaults to 15 minutes but can be configured through a server parameter. The documents in the range are then [deleted in batches](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/range_deletion_util.cpp#L312) with a [delay between each batch](https://github.com/mongodb/mongo/blob/49159e1cf859d21c767f6b582dd6e6b2d675808d/src/mongo/db/s/range_deletion_util.cpp#L338). This rate limiting is intended to reduce the I/O load from excessive deletions happening at the same time. When the deletion has been completed, the [range deletion document is deleted](https://github.com/mongodb/mongo/blob/52a73692175cad37f942ff5e6f3d70aacbbb113d/src/mongo/db/s/range_deletion_util.cpp#L485) from the local config.rangeDeletions collection.

## Orphan filtering

## Replicating the orphan filtering table

---

# Auto-splitting and auto-balancing

Data may need to redistributed for many reasons, such as that a shard was added, a shard was
requested to be removed, or data was inserted in an imbalanced way.

The config server replica set durably stores settings for the maximum chunk size and whether chunks
should be automatically split and balanced.

## Auto-splitting

## Auto-balancing

---

# DDL operations

Indexes are not stored in the routing table, so a router forwards index operations to all shards
that own chunks for the collection.

Collections are always created as unsharded, meaning they are not stored in the routing table, so
a router forwards create collection requests directly to the primary shard for the database. A
router also forwards rename collection requests directly to the primary shard, since only renaming
unsharded collections is supported.

A router forwards all other DDL operations, such as dropping a database or sharding a collection,
to the config server primary. The config server primary serializes conflicting operations, and
either itself coordinates the DDL operation or hands off the coordination to a shard. Coordinating
the DDL operation involves applying the operation on the correct set of shards and updating the
authoritative routing table.

#### Code references
* Example of a DDL command (create indexes) that mongos
[**forwards to all shards that own chunks**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/s/commands/cluster_create_indexes_cmd.cpp#L83)
* Example of a DDL command (create collection) that mongos
[**forwards to the primary shard**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/s/commands/cluster_create_cmd.cpp#L128)
* Example of a DDL command (drop collection) mongos
[**forwards to the config server primary**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/s/commands/cluster_drop_cmd.cpp#L81-L82)
* Example of a DDL command (drop collection) the config server
[**coordinates itself**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/configsvr_drop_collection_command.cpp).
The business logic for most DDL commands that the config server coordinates lives in the
[**ShardingCatalogManager class**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/sharding_catalog_manager.h#L86),
including the logic for
[**dropCollection**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/sharding_catalog_manager_collection_operations.cpp#L417).
However, note that the ShardingCatalogManager class also contains business logic to just commit some
operations that are otherwise coordinated by a shard.
* Example of a DDL command (shard collection) for which the config server
[**hands off coordination**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/configsvr_shard_collection_command.cpp)
to a shard. The business logic for such commands is in the shard's command body, such as the logic
for
[**shardCollection**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/shardsvr_shard_collection.cpp#L7830).

## Important caveats

### Database creation

There is no explicit command to create a database. When a router receives a write command, an entry
for the database is created in the config.databases collection if one doesn't already exist. Unlike
all other DDL operations, creating a database only involves choosing a primary shard (the shard with
the smallest total data size is chosen) and writing the database entry to the authoritative routing
table. That is, creating a database does not involve modifying any state on shards, since on shards,
a database only exists once a collection in it is created.

#### Code references
* Example of mongos
[**asking the config server to create a database**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/s/commands/cluster_create_cmd.cpp#L116)
if needed

### Retrying internally

DDL operations often involve multiple hops between nodes. Generally, if a command is idempotent on
the receiving node, the sending node will retry it upon receiving a retryable error, such as a
network or NotMaster error. There are some cases where the sending node retries even though the
command is not idempotent, such as in shardCollection. In this case, the receiving node may return
ManualInterventionRequired if the first attempt failed partway.

#### Code references
* Example of a DDL command (shard collection)
[**failing with ManualInterventionRequired**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/shardsvr_shard_collection.cpp#L129)

### Serializing conflicting operations

The concurrency control scheme has evolved over time and involves several different locks.

Distributed locks are locks on a string resource, typically a database name or collection name. They
are acquired by doing a majority write to a document in the `config.locks` collection on the config
servers. The write includes the identity of the process acquiring the lock. The process holding a
distributed lock must also periodically "ping" (update) a document in the `config.lockpings`
collection on the config servers containing its process id. If the process's document is not pinged
for 15 minutes or more, the process's distributed locks are allowed to be "overtaken" by another
process. Note that this means a distributed lock can be overtaken even though the original process
that had acquired the lock continues to believe it owns the lock. See
[**this blog post**](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) for
an excellent description of the distributed locking problem.

In the first implementation of distributed locks, a thread would wait for a lock to be released by
polling the lock document every 500 milliseconds for 20 seconds (and return a LockBusy error if the
thread never saw the lock as available.) NamespaceSerializer locks were introduced to allow a thread
to be notified more efficiently when a lock held by another thread on the same node was released.
NamespaceSerializer locks were added only to DDL operations which were seen to frequently fail with
"LockBusy" when run concurrently on the same database, such as dropCollection.

Global ResourceMutexes are the most recent, and are taken to serialize modifying specific config
collections, such as config.shards, config.chunks, and config.tags. For example, splitChunk,
mergeChunks, and moveChunk all take the chunk ResourceMutex.

#### Code references
* [**DistLockManager class**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/s/catalog/dist_lock_manager.h)
* [**DistLockCatalog class**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/s/catalog/dist_lock_catalog.h)
* [**NamespaceSerializer class**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/namespace_serializer.h)
* The interface for acquiring NamespaceSerializer locks
[**via the ShardingCatalogManager**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/sharding_catalog_manager.h#L276)
* The
[**global ResourceMutexes**](https://github.com/mongodb/mongo/blob/r4.3.4/src/mongo/db/s/config/sharding_catalog_manager.h#L555-L581)

---

# The logical clock and causal consistency

---

# Logical Sessions

Some operations, such as retryable writes and transactions, require durably storing metadata in the
cluster about the operation. However, it's important that this metadata does not remain in the
cluster forever.

Logical sessions provide a way to durably store metadata for the _latest_ operation in a sequence of
operations. The metadata is reaped if the cluster does not receive a new operation under the logical
session for a reasonably long time (the default is 30 minutes).

A logical session is identified by a globally unique id (UUID), called the `lsid`. An `lsid` can be
either generated by the driver (or mongo shell) or via the `startSession` server command. 

The order of operations in the logical session that need to durably store metadata is defined by an
integer counter, called the `txnNumber`. When the cluster receives a retryable write or transaction
with a higher `txnNumber` than the previous known `txnNumber`, the cluster overwrites the previous
metadata with the metadata for the new operation.

Operations sent with an `lsid` that do not need to durably store metadata simply bump the time at
which the session's metadata expires.

## The logical sessions cache

## The logical sessions catalog

## Retryable writes

## The historical routing table

## Transactions

---

# Sharding component hierarchy
