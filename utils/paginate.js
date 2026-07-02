// Small helper for backward-compatible, server-side pagination.
//
// isPaged(req)  -> true when the client asked for a page (?page=...)
// getPageParams(req) -> { page, limit, skip } with safe bounds
//
// When ?page is absent, callers keep returning a plain array (old behavior),
// so dropdowns / reports that expect an array are never broken.

function isPaged(req) {
  return req.query.page !== undefined && req.query.page !== null && req.query.page !== "";
}

function getPageParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let limit = parseInt(req.query.limit, 10) || 10;
  limit = Math.min(100, Math.max(1, limit)); // 1..100
  return { page, limit, skip: (page - 1) * limit };
}

function pagedResponse(data, total, page, limit, summary) {
  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    summary: summary || {}
  };
}

module.exports = { isPaged, getPageParams, pagedResponse };
