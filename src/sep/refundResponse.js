// Parses SEP RefundService SOAP responses (Refund_Reg / Refund_Exec / GetDailyRefundList /
// refresh), verified against a real captured GetDailyRefundList response on 2026-08-16.

function getTag(xml, tag) {
  const match = String(xml).match(new RegExp(`<a:${tag}>(.*?)</a:${tag}>`, "s"));
  return match ? match[1] : null;
}

// Refund_Reg / Refund_Exec response shape: ActionName, Description, ErrorCode,
// ErrorMessage, ReferenceId, RequestStatus.
function parseRefundActionResponse(xml) {
  return {
    actionName: getTag(xml, "ActionName"),
    description: getTag(xml, "Description"),
    errorCode: getTag(xml, "ErrorCode"),
    errorMessage: getTag(xml, "ErrorMessage"),
    referenceId: getTag(xml, "ReferenceId"),
    requestStatus: getTag(xml, "RequestStatus"),
  };
}

// GetDailyRefundList / GetRefundDetail: same envelope, but Description is a
// "\n"-joined, "|"-delimited table. Names below follow SEP's own column legend
// ("راهنما — رشته خروجی گزارش‌ها", refund service doc v3.14 pages 32-33, rows 1-24),
// cross-checked against a real 2026-08-16 response: column 0 equals the requestId sent to
// Refund_Reg, and column 12 equals the original purchase's RefNum.
//
// Two distinctions the earlier names blurred, and that callers get wrong otherwise:
//   - 9/10 describe a single refund ATTEMPT; 18/19 describe the OVERALL request.
//     Completion must be judged on refundStatusCode (19), not on attemptStatusText.
//   - 16 is when the refund was REQUESTED (Refund_Reg accepted), not when the money
//     moved. Execution follows in the next SEP cycle, up to 20 minutes later.
const DAILY_LIST_COLUMNS = [
  "requestId", "amount", "destinationCardOwner", "attemptDate", "destinationCard",
  "attemptId", "attemptReceipt", "attemptTrackingCode", "sourceCard",
  "attemptStatusText", "attemptStatusCode", "originalAmount",
  "originalRefNum", "originalResNum", "originalTermId", "originalTransactionDate",
  "refundRequestDate", "originalDestinationCard", "refundStatusText",
  "refundStatusCode", "refundTermId", "manualExecChange", "refundId",
  "documentDescription",
];

// Overall refund request status (doc v3.14 page 35).
const REFUND_STATUS = {
  START: "1",       // queued; the next service cycle will attempt it
  IN_PROGRESS: "2", // attempted, paused on a problem, will be retried
  OK: "3",          // money actually returned
  FAIL: "4",
  CANCEL: "5",
  NONE: "0",
};

function parseDailyRefundList(xml) {
  const header = parseRefundActionResponse(xml);
  const description = header.description || "";
  const clean = description.replace(/&#xD;\n?/g, "\n").replace(/\r/g, "").trim();

  const rows = clean
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row) => {
      const cols = row.split("|").map((v) => v.trim());
      const record = {};
      DAILY_LIST_COLUMNS.forEach((name, i) => {
        record[name] = cols[i] ?? "";
      });
      return record;
    });

  return { ...header, rows };
}

// RefreshRefundRequestByPartialRefundInfoId returns a per-request verdict, not the
// usual ErrorCode envelope: an outer Status plus one Item per partial refund. Two traps,
// both of which would read a refusal as a success and leave a customer's money stuck:
//   - the outer Status is "Ok" even when the item itself was refused (verified live
//     2026-09-22 on a request SEP had closed), so only the item counts;
//   - a request SEP auto-broke into parts answers with several items, and the first one
//     is not necessarily ours — so the item is matched on PartialRefundInfoId, and the
//     refresh only counts as accepted when every item that came back says Ok.
function parseRefreshResponse(xml, expectedId) {
  const text = String(xml);
  const items = [...text.matchAll(/<a:RefundItemResultDto>(.*?)<\/a:RefundItemResultDto>/gs)].map((m) => ({
    partialRefundInfoId: getTag(m[1], "PartialRefundInfoId"),
    resultStatus: getTag(m[1], "ResultStatus"),
    message: getTag(m[1], "Message"),
  }));

  const wanted = expectedId === undefined || expectedId === null
    ? items
    : items.filter((i) => String(i.partialRefundInfoId) === String(expectedId));
  const matched = wanted.length ? wanted : [];

  return {
    status: getTag(text, "Status"),
    items,
    resultStatus: matched.length ? matched.map((i) => i.resultStatus).join(",") : null,
    message: matched.length ? matched.map((i) => i.message).filter(Boolean).join(" / ") : null,
    // No item for the id we asked about means SEP did not answer our question — that is
    // an unknown outcome, never a success.
    accepted: matched.length > 0 && matched.every((i) => i.resultStatus === "Ok"),
  };
}

module.exports = { parseRefundActionResponse, parseDailyRefundList, parseRefreshResponse, DAILY_LIST_COLUMNS, REFUND_STATUS };
