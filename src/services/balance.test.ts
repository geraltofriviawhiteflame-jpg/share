import assert from "node:assert/strict";
import test from "node:test";
import { suggestTransfers } from "./balance";


test("suggestTransfers uses deterministic greedy matching", () => {
  const transfers = suggestTransfers([
    { memberId: "member-charan", amountPaise: -40_000 },
    { memberId: "member-anil", amountPaise: 80_000 },
    { memberId: "member-beena", amountPaise: -40_000 },
  ]);

  assert.deepEqual(transfers, [
    { fromMemberId: "member-beena", toMemberId: "member-anil", amountPaise: 40_000 },
    { fromMemberId: "member-charan", toMemberId: "member-anil", amountPaise: 40_000 },
  ]);
});

test("suggestTransfers rejects a non-zero balance sum", () => {
  assert.throws(
    () => suggestTransfers([{ memberId: "member-a", amountPaise: -1 }]),
    /group balances do not sum to zero/,
  );
});

test("suggestTransfers returns no transfers for zero balances", () => {
  assert.deepEqual(
    suggestTransfers([{ memberId: "member-a", amountPaise: 0 }]),
    [],
  );
});
