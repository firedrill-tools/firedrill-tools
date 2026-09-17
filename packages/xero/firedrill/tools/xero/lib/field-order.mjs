// Xero wire field order for envelope bodies. Firedrill stores idempotency receipts as canonical JSON (keys sorted),
// so a replayed outcome would otherwise render with alphabetical keys; the encoder re-orders every envelope through
// these shapes so first responses and replays are byte-identical apart from the per-request Id. Keys the shapes do
// not name keep their incoming order after the named ones. Shapes are fixed; no caller input reaches this module.

const ADDRESS = { order: ["AddressType", "AddressLine1", "AddressLine2", "AddressLine3", "AddressLine4", "City", "Region", "PostalCode", "Country", "AttentionTo"] };
const PHONE = { order: ["PhoneType", "PhoneNumber", "PhoneAreaCode", "PhoneCountryCode"] };
const MESSAGE = { order: ["Message"] };
const BALANCE = { order: ["Outstanding", "Overdue"] };
const BALANCES = { order: ["AccountsReceivable", "AccountsPayable"], children: { AccountsReceivable: BALANCE, AccountsPayable: BALANCE } };
const TERM = { order: ["Day", "Type"] };
const PAYMENT_TERMS = { order: ["Bills", "Sales"], children: { Bills: TERM, Sales: TERM } };

const CONTACT_REF = { order: ["ContactID", "Name", "ContactStatus"] };

const CONTACT = {
  order: [
    "ContactID", "ContactNumber", "AccountNumber", "ContactStatus", "Name", "FirstName", "LastName", "EmailAddress",
    "CompanyNumber", "TaxNumber", "AccountsReceivableTaxType", "AccountsPayableTaxType", "Addresses", "Phones",
    "DefaultCurrency", "Website", "PaymentTerms", "UpdatedDateUTC", "IsSupplier", "IsCustomer", "HasAttachments",
    "HasValidationErrors", "Balances", "StatusAttributeString", "ValidationErrors",
  ],
  children: { Addresses: ADDRESS, Phones: PHONE, PaymentTerms: PAYMENT_TERMS, Balances: BALANCES, ValidationErrors: MESSAGE },
};

const LINE_ITEM = {
  order: ["LineItemID", "Description", "Quantity", "UnitAmount", "ItemCode", "AccountCode", "TaxType", "TaxAmount", "LineAmount", "DiscountRate", "Tracking"],
};

const INVOICE_PAYMENT = { order: ["PaymentID", "Date", "Amount", "Reference", "CurrencyRate", "HasAccount", "HasValidationErrors"] };

const INVOICE = {
  order: [
    "Type", "InvoiceID", "InvoiceNumber", "Reference", "Payments", "CreditNotes", "Prepayments", "Overpayments", "AmountDue",
    "AmountPaid", "AmountCredited", "CurrencyRate", "IsDiscounted", "HasAttachments", "HasErrors", "Contact", "DateString",
    "Date", "DueDateString", "DueDate", "ExpectedPaymentDate", "PlannedPaymentDate", "Status", "LineAmountTypes", "LineItems",
    "SubTotal", "TotalTax", "Total", "UpdatedDateUTC", "CurrencyCode", "FullyPaidOnDate", "SentToContact",
    "StatusAttributeString", "ValidationErrors",
  ],
  children: { Payments: INVOICE_PAYMENT, Contact: CONTACT_REF, LineItems: LINE_ITEM, ValidationErrors: MESSAGE },
};

const ACCOUNT_REF = { order: ["AccountID", "Code", "Name"] };
const INVOICE_REF = { order: ["InvoiceID", "InvoiceNumber", "Type", "Contact"], children: { Contact: CONTACT_REF } };

const PAYMENT = {
  order: [
    "PaymentID", "Date", "DateString", "Amount", "BankAmount", "Reference", "CurrencyRate", "PaymentType", "Status",
    "IsReconciled", "HasAccount", "HasValidationErrors", "UpdatedDateUTC", "Account", "Invoice", "StatusAttributeString",
    "ValidationErrors",
  ],
  children: { Account: ACCOUNT_REF, Invoice: INVOICE_REF, ValidationErrors: MESSAGE },
};

const ACCOUNT = {
  order: [
    "AccountID", "Code", "Name", "Type", "Status", "Description", "BankAccountNumber", "BankAccountType", "CurrencyCode",
    "TaxType", "EnablePaymentsToAccount", "ShowInExpenseClaims", "Class", "SystemAccount", "ReportingCode",
    "ReportingCodeName", "HasAttachments", "UpdatedDateUTC", "AddToWatchlist",
  ],
};

const TAX_COMPONENT = { order: ["Name", "Rate", "IsCompound", "IsNonRecoverable"] };
const TAX_RATE = {
  order: [
    "Name", "TaxType", "ReportTaxType", "CanApplyToAssets", "CanApplyToEquity", "CanApplyToExpenses", "CanApplyToLiabilities",
    "CanApplyToRevenue", "DisplayTaxRate", "EffectiveRate", "Status", "TaxComponents",
  ],
  children: { TaxComponents: TAX_COMPONENT },
};

const ORGANISATION = {
  order: [
    "OrganisationID", "Name", "LegalName", "PaysTax", "Version", "OrganisationType", "BaseCurrency", "CountryCode",
    "IsDemoCompany", "OrganisationStatus", "RegistrationNumber", "TaxNumber", "FinancialYearEndDay", "FinancialYearEndMonth",
    "SalesTaxBasis", "SalesTaxPeriod", "DefaultSalesTax", "DefaultPurchasesTax", "PeriodLockDate", "EndOfYearLockDate",
    "CreatedDateUTC", "Timezone", "OrganisationEntityType", "ShortCode", "Class", "Edition", "LineOfBusiness", "Addresses",
    "Phones", "PaymentTerms",
  ],
  children: { Addresses: ADDRESS, Phones: PHONE, PaymentTerms: PAYMENT_TERMS },
};

const PAGINATION = { order: ["page", "pageSize", "pageCount", "itemCount"] };

/** Top-level envelope: Xero puts pagination before the collection (Accounting API 2.0 reference examples). */
export const ENVELOPE = {
  order: ["Id", "Status", "ProviderName", "DateTimeUTC", "pagination", "Organisations", "Accounts", "TaxRates", "Contacts", "Invoices", "Payments"],
  children: {
    pagination: PAGINATION,
    Organisations: ORGANISATION,
    Accounts: ACCOUNT,
    TaxRates: TAX_RATE,
    Contacts: CONTACT,
    Invoices: INVOICE,
    Payments: PAYMENT,
  },
};

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Copy of `value` with object keys in shape order (named keys first, then the rest in incoming order). */
export function orderFields(value, shape) {
  if (Array.isArray(value)) return value.map((item) => orderFields(item, shape));
  if (!isPlainObject(value) || shape === undefined) return value;
  const children = shape.children ?? {};
  const out = {};
  const seen = new Set();
  const put = (key) => {
    seen.add(key);
    const inner = orderFields(value[key], Object.hasOwn(children, key) ? children[key] : undefined);
    // defineProperty keeps every key an own property (a plain assignment of "__proto__" would set the prototype).
    Object.defineProperty(out, key, { value: inner, enumerable: true, writable: true, configurable: true });
  };
  for (const key of shape.order) if (Object.hasOwn(value, key)) put(key);
  for (const key of Object.keys(value)) if (!seen.has(key)) put(key);
  return out;
}
