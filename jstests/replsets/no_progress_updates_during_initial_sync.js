/**
 * Test that a node in initial sync does not report replication progress. There are two routes
 * these kinds of updates take:
 *  - via spanning tree:
 *      initial-syncing nodes should send no replSetUpdatePosition commands upstream at all
 *  - via heartbeats:
 *      these nodes should include null lastApplied and lastDurable optimes in heartbeat responses
 */
(function() {
"use strict";

load("jstests/libs/write_concern_util.js");

const testName = jsTestName();
const rst = new ReplSetTest({name: testName, nodes: [{}, {rsConfig: {priority: 0}}]});
rst.startSet();
rst.initiate();

const primary = rst.getPrimary();
const primaryDb = primary.getDB("test");
assert.commandWorked(primaryDb.test.insert({"starting": "doc"}, {writeConcern: {w: 2}}));

jsTestLog("Adding a new node to the replica set");

const secondary = rst.add({
    rsConfig: {priority: 0},
    setParameter: {
        'failpoint.forceSyncSourceCandidate':
            tojson({mode: 'alwaysOn', data: {"hostAndPort": primary.host}}),
        // Used to guarantee we have something to fetch.
        'failpoint.initialSyncHangAfterDataCloning': tojson({mode: 'alwaysOn'}),
        'failpoint.initialSyncHangBeforeFinish': tojson({mode: 'alwaysOn'}),
        'numInitialSyncAttempts': 1,
    }
});
rst.reInitiate();
rst.waitForState(secondary, ReplSetTest.State.STARTUP_2);

// Shut down the steady-state secondary so that it cannot participate in the majority.
rst.stop(1);

// Make sure we are through with cloning before inserting more docs on the primary, so that we can
// guarantee we have to fetch and apply them. We begin fetching inclusively of the primary's
// lastApplied.
assert.commandWorked(secondary.adminCommand({
    waitForFailPoint: "initialSyncHangAfterDataCloning",
    timesEntered: 1,
    maxTimeMS: kDefaultWaitForFailPointTimeout
}));

jsTestLog("Inserting some docs on the primary to advance its lastApplied");

assert.commandWorked(primaryDb.test.insert([{a: 1}, {b: 2}, {c: 3}, {d: 4}, {e: 5}]));

jsTestLog("Resuming initial sync");

assert.commandWorked(
    secondary.adminCommand({configureFailPoint: "initialSyncHangAfterDataCloning", mode: "off"}));

assert.commandWorked(secondary.adminCommand({
    waitForFailPoint: "initialSyncHangBeforeFinish",
    timesEntered: 1,
    maxTimeMS: kDefaultWaitForFailPointTimeout
}));

// 1. Make sure the initial syncing node sent no replSetUpdatePosition commands while applying.
sleep(4 * 1000);
const numUpdatePosition = assert.commandWorked(secondary.adminCommand({serverStatus: 1}))
                              .metrics.repl.network.replSetUpdatePosition.num;
assert.eq(0, numUpdatePosition);

const nullOpTime = {
    "ts": Timestamp(0, 0),
    "t": NumberLong(-1)
};
const nullWallTime = ISODate("1970-01-01T00:00:00Z");

// 2. It also should not participate in the acknowledgement of any writes.
const writeResW2 = primaryDb.runCommand({
    insert: "test",
    documents: [{"writeConcernTwo": "shouldfail"}],
    writeConcern: {w: 2, wtimeout: 4000}
});
assert.commandWorkedIgnoringWriteConcernErrors(writeResW2);
checkWriteConcernTimedOut(writeResW2);

// The lastCommitted opTime should not advance on the secondary.
const opTimesAfterW2 = assert.commandWorked(secondary.adminCommand({replSetGetStatus: 1})).optimes;
assert.docEq(opTimesAfterW2.lastCommittedOpTime, nullOpTime, () => tojson(opTimesAfterW2));
assert.eq(nullWallTime, opTimesAfterW2.lastCommittedWallTime, () => tojson(opTimesAfterW2));

const writeResWMaj = primaryDb.runCommand({
    insert: "test",
    documents: [{"writeConcernMajority": "shouldfail"}],
    writeConcern: {w: "majority", wtimeout: 4000}
});
assert.commandWorkedIgnoringWriteConcernErrors(writeResWMaj);
checkWriteConcernTimedOut(writeResWMaj);

// The lastCommitted opTime should not advance on the secondary.
const statusAfterWMaj = assert.commandWorked(secondary.adminCommand({replSetGetStatus: 1}));
const opTimesAfterWMaj = statusAfterWMaj.optimes;
assert.docEq(opTimesAfterWMaj.lastCommittedOpTime, nullOpTime, () => tojson(opTimesAfterWMaj));
assert.eq(nullWallTime, opTimesAfterWMaj.lastCommittedWallTime, () => tojson(opTimesAfterWMaj));

// 3. Make sure that even though the lastApplied and lastDurable have advanced on the secondary...
const secondaryOpTimes = opTimesAfterWMaj;
assert.gte(
    bsonWoCompare(secondaryOpTimes.appliedOpTime, nullOpTime), 0, () => tojson(secondaryOpTimes));
assert.gte(
    bsonWoCompare(secondaryOpTimes.durableOpTime, nullOpTime), 0, () => tojson(secondaryOpTimes));
assert.neq(nullWallTime, secondaryOpTimes.optimeDate, () => tojson(secondaryOpTimes));
assert.neq(nullWallTime, secondaryOpTimes.optimeDurableDate, () => tojson(secondaryOpTimes));

// ...the primary thinks they're still null as they were null in the heartbeat responses.
const primaryStatusRes = assert.commandWorked(primary.adminCommand({replSetGetStatus: 1}));
const secondaryOpTimesAsSeenByPrimary = primaryStatusRes.members[2];
assert.docEq(secondaryOpTimesAsSeenByPrimary.optime,
             nullOpTime,
             () => tojson(secondaryOpTimesAsSeenByPrimary));
assert.docEq(secondaryOpTimesAsSeenByPrimary.optimeDurable,
             nullOpTime,
             () => tojson(secondaryOpTimesAsSeenByPrimary));
assert.eq(nullWallTime,
          secondaryOpTimesAsSeenByPrimary.optimeDate,
          () => tojson(secondaryOpTimesAsSeenByPrimary));
assert.eq(nullWallTime,
          secondaryOpTimesAsSeenByPrimary.optimeDurableDate,
          () => tojson(secondaryOpTimesAsSeenByPrimary));

// 4. Finally, confirm that we did indeed fetch and apply all documents during initial sync.
assert(statusAfterWMaj.initialSyncStatus,
       () => "Response should have an 'initialSyncStatus' field: " + tojson(statusAfterWMaj));
// We should have applied at least 6 documents, not 5, as fetching and applying are inclusive of the
// sync source's lastApplied.
assert.gte(statusAfterWMaj.initialSyncStatus.appliedOps, 6);

// Turn off the last failpoint and wait for the node to finish initial sync.
assert.commandWorked(
    secondary.adminCommand({configureFailPoint: "initialSyncHangBeforeFinish", mode: "off"}));
rst.awaitSecondaryNodes(null, [secondary]);

// The set should now be able to satisfy {w:2} writes.
assert.commandWorked(
    primaryDb.runCommand({insert: "test", documents: [{"will": "succeed"}], writeConcern: {w: 2}}));

rst.restart(1);
rst.stopSet();
})();
