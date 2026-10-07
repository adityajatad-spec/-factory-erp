import type {
  CreateItemRequest,
  CreatePartyRequest,
  CreditNoteReason,
  RoleCode,
} from '@factory-erp/contracts';

/**
 * SYNTHETIC DEMO DATA — every name, GSTIN, address, bank detail and tax rate here is fictional.
 *
 * GSTINs use a PAN segment whose 4th character is "O", which is not a valid PAN holder type,
 * so they can never collide with a real registration. GST rates are tagged DEMO_UNVERIFIED and
 * must not be used for real invoicing [VERIFY R-01].
 */

export const DEMO_COMPANY = {
  legalName: 'Demo Manufacturing Pvt Ltd',
  tradeName: 'Demo Manufacturing',
  gstin: '27DEMOM0001A1Z1',
  stateCode: '27',
  pan: 'DEMOM0001A',
  addressLine1: 'Plot D-1, Demo Industrial Estate',
  addressLine2: 'Sample MIDC Area',
  city: 'Pune',
  postalCode: '411000',
  phone: '+91 00000 00000',
  email: 'accounts@demo-manufacturing.example',
  bankDetails: {
    bankName: 'Demo Bank Ltd (fictional)',
    accountName: 'Demo Manufacturing Pvt Ltd',
    accountNumber: '000000000000',
    ifsc: 'DEMO0000001',
    branch: 'Demo Branch',
  },
  invoiceTerms:
    'Payment due within 30 days of invoice date. Goods once sold will not be taken back. DEMO DATA — not a real business.',
};

export const DEMO_USERS: ReadonlyArray<{ username: string; displayName: string; role: RoleCode }> =
  [
    { username: 'owner', displayName: 'Demo Owner', role: 'OWNER' },
    { username: 'admin', displayName: 'Demo Admin', role: 'ADMIN' },
    { username: 'accountant', displayName: 'Demo Accountant', role: 'ACCOUNTANT' },
    { username: 'production', displayName: 'Demo Production Manager', role: 'PRODUCTION_MANAGER' },
    { username: 'purchase', displayName: 'Demo Purchase Manager', role: 'PURCHASE_MANAGER' },
    { username: 'hrmanager', displayName: 'Demo HR Manager', role: 'HR' },
    { username: 'supervisor', displayName: 'Demo Supervisor', role: 'SUPERVISOR' },
    { username: 'worker', displayName: 'Demo Worker', role: 'WORKER' },
  ];

export const DEMO_RATE_NOTE =
  'DEMO DATA — synthetic rate for development only. Not verified against official notifications [VERIFY R-01].';

export const DEMO_HSN: ReadonlyArray<{ code: string; description: string; rate: string }> = [
  { code: '7208', description: 'Flat-rolled products of iron or non-alloy steel', rate: '18' },
  { code: '7222', description: 'Bars and rods of stainless steel', rate: '18' },
  { code: '7307', description: 'Tube or pipe fittings of iron or steel', rate: '18' },
  { code: '7318', description: 'Screws, bolts, nuts and washers of iron or steel', rate: '18' },
  { code: '7326', description: 'Other articles of iron or steel', rate: '18' },
  { code: '8483', description: 'Transmission shafts, bearings and gears', rate: '18' },
  { code: '2710', description: 'Lubricating oils', rate: '18' },
  { code: '4819', description: 'Cartons and boxes of paper', rate: '5' },
  { code: '998898', description: 'Job-work manufacturing services', rate: '5' },
];

export const DEMO_PARTIES: ReadonlyArray<CreatePartyRequest> = [
  {
    code: 'C-SHARMA',
    name: 'Sharma Components',
    isCustomer: true,
    isSupplier: false,
    gstin: '27DEMOS0101A1Z5',
    stateCode: '27',
    addressLine1: 'Unit 4, Demo Udyog Nagar',
    city: 'Pune',
    postalCode: '411001',
    contactName: 'R. Sharma (fictional)',
    creditDays: 30,
  },
  {
    code: 'C-DSW',
    name: 'Demo Steel Works',
    isCustomer: true,
    isSupplier: false,
    gstin: '24DEMOW0202B1Z3',
    stateCode: '24',
    addressLine1: 'Survey 12, Demo GIDC Estate',
    city: 'Ahmedabad',
    postalCode: '380000',
    contactName: 'Purchase desk',
    creditDays: 45,
  },
  {
    code: 'C-ABC',
    name: 'ABC Industrial Supplies',
    isCustomer: true,
    isSupplier: true,
    gstin: '27DEMOA0303C1Z1',
    stateCode: '27',
    addressLine1: 'Shop 7, Demo Market Yard',
    city: 'Pune',
    postalCode: '411002',
    creditDays: 15,
  },
  {
    code: 'C-FAP',
    name: 'Fictional Auto Parts Ltd',
    isCustomer: true,
    isSupplier: false,
    gstin: '29DEMOF0404D1Z9',
    stateCode: '29',
    addressLine1: 'Plot 22, Example Industrial Area',
    city: 'Bengaluru',
    postalCode: '560000',
    creditDays: 60,
  },
  {
    code: 'C-SEC',
    name: 'Sample Engineering Co',
    isCustomer: true,
    isSupplier: false,
    gstin: '33DEMOE0505E1Z7',
    stateCode: '33',
    addressLine1: '5th Cross, Demo SIDCO Estate',
    city: 'Chennai',
    postalCode: '600000',
    creditDays: 30,
  },
  {
    code: 'C-WALKIN',
    name: 'Walk-in Customer (Unregistered)',
    isCustomer: true,
    isSupplier: false,
    stateCode: '27',
    city: 'Pune',
  },
  {
    code: 'S-DMT',
    name: 'Demo Metals Trading',
    isCustomer: false,
    isSupplier: true,
    gstin: '27DEMOT0606F1Z5',
    stateCode: '27',
    addressLine1: 'Godown 3, Demo Steel Market',
    city: 'Pune',
    postalCode: '411003',
    creditDays: 30,
  },
  {
    code: 'S-SPC',
    name: 'Sample Packaging Co',
    isCustomer: false,
    isSupplier: true,
    gstin: '27DEMOP0707G1Z3',
    stateCode: '27',
    city: 'Pune',
    creditDays: 15,
  },
  {
    code: 'S-EXL',
    name: 'Example Lubricants',
    isCustomer: false,
    isSupplier: true,
    gstin: '24DEMOL0808H1Z1',
    stateCode: '24',
    city: 'Vadodara',
    creditDays: 30,
  },
];

export const DEMO_ITEMS: ReadonlyArray<CreateItemRequest & { openingStock?: string }> = [
  {
    code: 'BA-100',
    name: 'Bracket Assembly BA-100',
    itemType: 'FINISHED_GOOD',
    uom: 'NOS',
    hsnCode: '7326',
    defaultSaleRate: '245.00',
    openingStock: '1200',
  },
  {
    code: 'SF-50',
    name: 'Steel Flange 50 mm',
    itemType: 'FINISHED_GOOD',
    uom: 'NOS',
    hsnCode: '7307',
    defaultSaleRate: '380.00',
    openingStock: '640',
  },
  {
    code: 'MS-25',
    name: 'Machined Shaft 25 mm',
    itemType: 'FINISHED_GOOD',
    uom: 'NOS',
    hsnCode: '8483',
    defaultSaleRate: '1150.00',
    openingStock: '210',
  },
  {
    code: 'HB-M10',
    name: 'Hex Bolt Kit M10 (box of 100)',
    itemType: 'COMPONENT',
    uom: 'BOX',
    hsnCode: '7318',
    defaultSaleRate: '420.00',
    openingStock: '85',
  },
  {
    code: 'PKG-CRT',
    name: 'Corrugated Shipping Carton',
    itemType: 'COMPONENT',
    uom: 'NOS',
    hsnCode: '4819',
    defaultSaleRate: '38.50',
    openingStock: '2500',
  },
  {
    code: 'JW-MACH',
    name: 'CNC Machining Job Work (per piece)',
    itemType: 'SERVICE',
    uom: 'NOS',
    hsnCode: '998898',
    defaultSaleRate: '95.00',
  },
  {
    code: 'RM-MS2',
    name: 'MS Sheet 2 mm',
    itemType: 'RAW_MATERIAL',
    uom: 'KGS',
    hsnCode: '7208',
    defaultSaleRate: null,
    openingStock: '4850.5',
  },
  {
    code: 'RM-SS20',
    name: 'SS 304 Round Bar 20 mm',
    itemType: 'RAW_MATERIAL',
    uom: 'KGS',
    hsnCode: '7222',
    defaultSaleRate: null,
    openingStock: '920.25',
  },
  {
    code: 'CON-OIL',
    name: 'Cutting Oil (soluble)',
    itemType: 'CONSUMABLE',
    uom: 'LTR',
    hsnCode: '2710',
    defaultSaleRate: null,
    openingStock: '140',
  },
];

/** Invoices to create, `daysAgo` relative to the seed date. Issued oldest-first. */
export const DEMO_INVOICES: ReadonlyArray<{
  /** Stable reference so demo receipts can name the invoices they pay. */
  ref: string;
  customer: string;
  daysAgo: number;
  issue: boolean;
  notes?: string;
  lines: ReadonlyArray<{
    item: string;
    quantity: string;
    unitRate: string;
    discountPercent?: string;
  }>;
}> = [
  // Older invoices so receivables ageing has something in every bucket.
  {
    ref: 'A1',
    customer: 'C-FAP',
    daysAgo: 118,
    issue: true,
    lines: [{ item: 'MS-25', quantity: '40', unitRate: '1150.00' }],
  },
  {
    ref: 'A2',
    customer: 'C-SEC',
    daysAgo: 96,
    issue: true,
    lines: [{ item: 'BA-100', quantity: '300', unitRate: '240.00' }],
  },
  {
    ref: 'A3',
    customer: 'C-ABC',
    daysAgo: 74,
    issue: true,
    lines: [{ item: 'JW-MACH', quantity: '500', unitRate: '95.00' }],
  },
  {
    ref: 'A4',
    customer: 'C-DSW',
    daysAgo: 52,
    issue: true,
    lines: [{ item: 'SF-50', quantity: '120', unitRate: '380.00' }],
  },
  {
    ref: 'A5',
    customer: 'C-SHARMA',
    daysAgo: 35,
    issue: true,
    lines: [{ item: 'BA-100', quantity: '500', unitRate: '245.00' }],
  },
  {
    ref: 'I1',
    customer: 'C-SHARMA',
    daysAgo: 9,
    issue: true,
    lines: [
      { item: 'BA-100', quantity: '400', unitRate: '245.00' },
      { item: 'PKG-CRT', quantity: '20', unitRate: '38.50' },
    ],
  },
  {
    ref: 'I2',
    customer: 'C-DSW',
    daysAgo: 8,
    issue: true,
    notes: 'Inter-state supply (Gujarat).',
    lines: [{ item: 'SF-50', quantity: '150', unitRate: '380.00', discountPercent: '5' }],
  },
  {
    ref: 'I3',
    customer: 'C-FAP',
    daysAgo: 6,
    issue: true,
    lines: [
      { item: 'MS-25', quantity: '60', unitRate: '1150.00' },
      { item: 'HB-M10', quantity: '12', unitRate: '420.00' },
    ],
  },
  {
    ref: 'I4',
    customer: 'C-ABC',
    daysAgo: 4,
    issue: true,
    lines: [{ item: 'JW-MACH', quantity: '320', unitRate: '95.00' }],
  },
  {
    ref: 'I5',
    customer: 'C-SEC',
    daysAgo: 2,
    issue: true,
    lines: [
      { item: 'BA-100', quantity: '250', unitRate: '240.00', discountPercent: '2.5' },
      { item: 'SF-50', quantity: '40', unitRate: '380.00' },
    ],
  },
  {
    ref: 'I6',
    customer: 'C-SHARMA',
    daysAgo: 0,
    issue: true,
    lines: [
      { item: 'MS-25', quantity: '25', unitRate: '1150.00' },
      { item: 'PKG-CRT', quantity: '5', unitRate: '38.50' },
    ],
  },
  {
    ref: 'I7',
    customer: 'C-WALKIN',
    daysAgo: 0,
    issue: true,
    lines: [{ item: 'HB-M10', quantity: '2', unitRate: '420.00' }],
  },
  // Issued by mistake and cancelled the same day (see DEMO_CANCELLATIONS).
  {
    ref: 'I8',
    customer: 'C-FAP',
    daysAgo: 0,
    issue: true,
    lines: [{ item: 'HB-M10', quantity: '5', unitRate: '420.00' }],
  },
  {
    ref: 'D1',
    customer: 'C-DSW',
    daysAgo: 0,
    issue: false,
    notes: 'Awaiting PO confirmation.',
    lines: [{ item: 'BA-100', quantity: '600', unitRate: '238.00' }],
  },
  {
    ref: 'D2',
    customer: 'C-ABC',
    daysAgo: 0,
    issue: false,
    lines: [
      { item: 'SF-50', quantity: '30', unitRate: '385.00' },
      { item: 'JW-MACH', quantity: '100', unitRate: '95.00' },
    ],
  },
];

/**
 * Demo customer receipts, oldest first (receipt numbering follows dates). Together they show
 * full, partial and multi-invoice allocation, an overpayment kept on account, and cash.
 */
export const DEMO_RECEIPTS: ReadonlyArray<{
  customer: string;
  daysAgo: number;
  amount: string;
  paymentMode: 'BANK_TRANSFER' | 'UPI' | 'CHEQUE' | 'CASH';
  reference: string | null;
  allocations: ReadonlyArray<{ invoice: string; amount: string }>;
}> = [
  // Full payment of a 118-day-old invoice.
  {
    customer: 'C-FAP',
    daysAgo: 90,
    amount: '54280.00',
    paymentMode: 'BANK_TRANSFER',
    reference: 'DEMO-NEFT-0001',
    allocations: [{ invoice: 'A1', amount: '54280.00' }],
  },
  // Part payment: the rest of A3 stays outstanding in the 61–90 day bucket.
  {
    customer: 'C-ABC',
    daysAgo: 60,
    amount: '25000.00',
    paymentMode: 'CHEQUE',
    reference: 'DEMO-CHQ-000101',
    allocations: [{ invoice: 'A3', amount: '25000.00' }],
  },
  {
    customer: 'C-SHARMA',
    daysAgo: 30,
    amount: '144550.00',
    paymentMode: 'UPI',
    reference: 'DEMO-UPI-7781',
    allocations: [{ invoice: 'A5', amount: '144550.00' }],
  },
  {
    customer: 'C-DSW',
    daysAgo: 3,
    amount: '40000.00',
    paymentMode: 'CHEQUE',
    reference: 'DEMO-CHQ-000452',
    allocations: [{ invoice: 'A4', amount: '40000.00' }],
  },
  {
    customer: 'C-SEC',
    daysAgo: 1,
    amount: '50000.00',
    paymentMode: 'BANK_TRANSFER',
    reference: 'DEMO-RTGS-0093',
    allocations: [{ invoice: 'A2', amount: '50000.00' }],
  },
  // One receipt paying two invoices in full, with ₹9,424 left over on account (overpayment rule).
  {
    customer: 'C-SHARMA',
    daysAgo: 0,
    amount: '160000.00',
    paymentMode: 'BANK_TRANSFER',
    reference: 'DEMO-NEFT-0002',
    allocations: [
      { invoice: 'I1', amount: '116449.00' },
      { invoice: 'I6', amount: '34127.00' },
    ],
  },
  {
    customer: 'C-WALKIN',
    daysAgo: 0,
    amount: '991.00',
    paymentMode: 'CASH',
    reference: null,
    allocations: [{ invoice: 'I7', amount: '991.00' }],
  },
];

/** Issued invoices cancelled through the cancel command (only unpaid, uncredited ones can be). */
export const DEMO_CANCELLATIONS: ReadonlyArray<{ invoice: string; reason: string }> = [
  {
    invoice: 'I8',
    reason: 'Raised in error — duplicate of an invoice already issued today (demo)',
  },
];

/**
 * Demo credit notes, oldest first (credit-note numbering follows dates). One price correction on
 * a part-paid inter-state invoice, one partial return, and one draft that is not issued yet.
 */
export const DEMO_CREDIT_NOTES: ReadonlyArray<{
  invoice: string;
  daysAgo: number;
  issue: boolean;
  reasonCode: CreditNoteReason;
  reason: string;
  lines: ReadonlyArray<{ invoiceLineNo: number; quantity: string; unitRate: string }>;
}> = [
  // A4 (₹53,808, ₹40,000 received): ₹10/unit price correction on 120 units → ₹1,416 incl. IGST.
  {
    invoice: 'A4',
    daysAgo: 2,
    issue: true,
    reasonCode: 'PRICE_CORRECTION',
    reason: 'Rate revised from ₹380 to ₹370 per unit as agreed with the customer (demo)',
    lines: [{ invoiceLineNo: 1, quantity: '120', unitRate: '10.00' }],
  },
  // I2: 10 of 150 units returned, at the invoiced rate less the same 5 % discount.
  {
    invoice: 'I2',
    daysAgo: 1,
    issue: true,
    reasonCode: 'SALES_RETURN',
    reason: '10 units returned — surface rust found on delivery (demo)',
    lines: [{ invoiceLineNo: 1, quantity: '10', unitRate: '380.00' }],
  },
  {
    invoice: 'I4',
    daysAgo: 0,
    issue: false,
    reasonCode: 'DEFICIENT_SUPPLY',
    reason: '20 pieces short-shipped; awaiting customer confirmation (demo)',
    lines: [{ invoiceLineNo: 1, quantity: '20', unitRate: '95.00' }],
  },
];
