// Synthetic Waterfall account for Firedrill. Every operation computes from `context.state`: a seeded directory of
// persons and companies, one account with a master key and sub-keys, a prepaid balance and unit prices. Job ids
// come from the seeded random source, timestamps from the virtual clock. Nothing here contacts any real service.
import { guardRoutes } from "./lib/json-depth.mjs";
import { finderRoute, jsonRoute, queryRoute } from "./lib/wire.mjs";
import { accountGet, apiKeysCreate, apiKeysList, apiKeysModify } from "./ops/account.mjs";
import { jobChangeGet, jobChangeRun, verifyEmailRun } from "./ops/change-verify.mjs";
import { companyGet, companyLaunch, contactGet, contactLaunch, phoneGet, phoneLaunch } from "./ops/enrichment.mjs";
import { searchCompanyGet, searchCompanyRun } from "./ops/search-company.mjs";
import { searchContactGet, searchContactRun } from "./ops/search-contact.mjs";

const operations = {
  "enrichment.contact.launch": contactLaunch,
  "enrichment.contact.get": contactGet,
  "enrichment.phone.launch": phoneLaunch,
  "enrichment.phone.get": phoneGet,
  "enrichment.company.launch": companyLaunch,
  "enrichment.company.get": companyGet,
  "search.contact.run": searchContactRun,
  "search.contact.get": searchContactGet,
  "search.company.run": searchCompanyRun,
  "search.company.get": searchCompanyGet,
  "job_change.run": jobChangeRun,
  "job_change.get": jobChangeGet,
  "verify.email.run": verifyEmailRun,
  "account.get": accountGet,
  "api_keys.list": apiKeysList,
  "api_keys.create": apiKeysCreate,
  "api_keys.modify": apiKeysModify,
};

const http = guardRoutes({
  "launch-enrichment-contact": jsonRoute(),
  "get-enrichment-contact": finderRoute(),
  "launch-enrichment-phone": jsonRoute(),
  "get-enrichment-phone": finderRoute(),
  "launch-enrichment-company": jsonRoute(),
  "get-enrichment-company": finderRoute(),
  "run-search-contact": jsonRoute(),
  "get-search-contact": finderRoute(),
  "run-search-company": jsonRoute(),
  "get-search-company": finderRoute(),
  "run-job-change": jsonRoute(),
  "get-job-change": finderRoute(),
  "verify-email": jsonRoute(),
  "get-account": queryRoute(["month", "start_date", "end_date"]),
  "list-api-keys": queryRoute([]),
  "create-api-key": jsonRoute(),
  "modify-api-key": jsonRoute(),
});

export default { operations, http };
