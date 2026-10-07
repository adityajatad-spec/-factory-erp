# Factory ERP — Documents and Data Collection Checklist

> **Deferred:** Factory discovery is deferred because the current build is a surprise prototype. These documents will be used later for real-world validation and factory-specific configuration.

**Version:** 0.1 (2026-10-05)
**Status:** awaiting approval for use (R2-D7)

**Use with:** [`factory-discovery-questionnaire.md`](factory-discovery-questionnaire.md). Question IDs in brackets show which questions each item supports.

> **For the factory visit, use [`factory-discovery-pack.md`](factory-discovery-pack.md)** (PDF: `factory-discovery-pack.pdf`). The pack sorts these items into MUST, HIGH VALUE and NICE TO HAVE, and gives the exact variations to collect. **Where its sample counts differ from this file, the pack wins.** The document IDs are the same in both.

---

## Data-handling rules (mandatory, before collecting anything)
1. **Get written consent from the owner** for collecting business documents and using them for design and testing.
2. **Get separate, explicit consent** to use documents in the **AI evaluation set**. Get further separate consent before **any** document is sent to a cloud AI service, even for benchmarking.
3. **Redact before storing:** Aadhaar numbers, personal bank account numbers, individual salaries and personal phone numbers of workers. Business GSTINs and invoice contents may be kept unredacted for design and testing if the owner agrees.
4. **Store originals encrypted and outside this repository.** Sample documents, exports and photos are **never committed to git**. The repository may contain only redacted, synthetic or explicitly approved fixtures.
5. **Label every item** with its checklist ID, source person, date collected and a redaction note.
6. **Collect copies, never originals.** Use photos or scans, or software exports.
7. Keep a **collection log** recording who collected what, when, where it's stored and who can access it.

---

## Checklist

### LG — Legal and registration
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| LG-01 | GST registration certificate(s) for every GSTIN | All | Entities, states, places of business (A-02) | ☐ |
| LG-02 | Entity type evidence (incorporation or partnership deed, first page only) | 1 | Entity type, audit-trail applicability (A-01) | ☐ |
| LG-03 | Udyam certificate | If any | MSME status (A-08) | ☐ |
| LG-04 | LUT and IEC | If exports | Export handling (A-07) | ☐ |
| LG-05 | Turnover band confirmation (from the CA) | 1 | E-invoicing and HSN applicability (A-04) | ☐ |

### SL — Sales
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| SL-01 | Recent sales invoices covering **every type used**: intra-state, inter-state, B2C, export/SEZ, scrap, job work | 30–50 | Template, fields, tax patterns, golden test cases (G-06) | ☐ |
| SL-02 | E-invoices with IRN/QR | 10+ if used | QR decoding tests, e-invoice flow (A-05) | ☐ |
| SL-03 | Credit and debit notes | 5–10 | Correction flows (G-08) | ☐ |
| SL-04 | Delivery challans, packing lists, gate passes | 5–10 each | Dispatch flow (G-05) | ☐ |
| SL-05 | E-way bills | 5–10 if used | Dispatch compliance (A-06) | ☐ |
| SL-06 | Quotations and customer POs | 5–10 each | Order-to-cash flow (G-02, G-03) | ☐ |
| SL-07 | Price lists or rate contracts | All current | Pricing model (G-04) | ☐ |
| SL-08 | Photo of pre-printed invoice stationery, and a printed copy set | 1 set | PDF and print design (G-06, M-10) | ☐ |
| SL-09 | Invoices from either side of a fiscal-year boundary | 2–4 | Numbering series behaviour (G-07) | ☐ |

### PU — Purchasing
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| PU-01 | **Supplier bills: realistic mix** of printed, **handwritten**, PDF and e-invoice, including **photos taken the way staff would take them** | **150–200** | Document AI gold set and accuracy benchmark (H-07). Consent rule 2 applies. | ☐ |
| PU-02 | POs issued to suppliers, or screenshots of WhatsApp orders | 10–20 | Procure-to-pay flow (H-03) | ☐ |
| PU-03 | Inward register or GRN pages, and weighbridge slips | 2 weeks' worth | Goods receipt flow (H-05) | ☐ |
| PU-04 | Incoming inspection records | 5–10 | Quality flow (H-06) | ☐ |
| PU-05 | Freight and transport bills | 5 | Reverse-charge handling (H-13) | ☐ |
| PU-06 | Job-work challans, outward and inward | 5–10 if any | Job-work flow (B-12) | ☐ |
| PU-07 | Supplier list with GSTINs, as exported from the accounting software | 1 | Master data quality and matching (P-03) | ☐ |

### IN — Inventory
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| IN-01 | Item master export (codes, names, units, HSN, groups) | 1 | Catalogue design, master-data cleanup (C-02) | ☐ |
| IN-02 | Stock register or stock report (latest) | 1 | Inventory model (C-05) | ☐ |
| IN-03 | Last physical stock-count sheet and its variance report | 1 | Accuracy baseline (C-06) | ☐ |
| IN-04 | Material issue slips or register | 1–2 weeks | Issue flow (C-04) | ☐ |
| IN-05 | Unit conversion examples (kg↔pcs, sheets↔kg) | All known | UoM model (B-08) | ☐ |
| IN-06 | Sketch or photo of store layout and locations | 1 | Warehouse and bin model (C-03) | ☐ |

### PR — Production
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| PR-01 | Daily and weekly production plans | 2–4 weeks | Planning flow (E-01, E-02) | ☐ |
| PR-02 | Shift production registers or reports | **1 month** | What is recorded today, plus volumes and baselines (E-03) | ☐ |
| PR-03 | Job cards or work orders | 5–10 | Work-order model (E-07) | ☐ |
| PR-04 | BOMs or recipe sheets for the top products | Top 10 products | BOM model (B-07) | ☐ |
| PR-05 | Process flow for the top 3 products, drawn during the visit | 3 | Routing and stages (B-05) | ☐ |
| PR-06 | Reject, rework and scrap records | 1 month | Quality and yield (B-10, B-11) | ☐ |
| PR-07 | Downtime logs, if any | 1 month | Downtime model (D-05) | ☐ |
| PR-08 | Targets, standard outputs and cycle times, if any | All | Variance analysis (E-04, E-05) | ☐ |

### MM — Machines and maintenance
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| MM-01 | Machine list: name, type, make, model, year, location, criticality | All | Machine master (D-01) | ☐ |
| MM-02 | Nameplate photos | All critical machines | Accurate specs | ☐ |
| MM-03 | Breakdown and maintenance logs | 3–6 months | Maintenance flow and baselines (D-04) | ☐ |
| MM-04 | Preventive maintenance schedules and checklists | All | PM design (D-06) | ☐ |
| MM-05 | AMC contracts (cover page and scope) | All | Vendor model (D-08) | ☐ |
| MM-06 | Critical spares list | 1 | Spares inventory (D-07) | ☐ |

### WF — Workforce
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| WF-01 | Employee list: code, department, designation, employment type, shift. **No Aadhaar, bank details or salary.** | All | Workforce master (F-01) | ☐ |
| WF-02 | Shift schedule and roster | Current plus 1 past month | Shift model (F-03) | ☐ |
| WF-03 | Attendance sample: register pages **and** a biometric device export file | 1 month | Attendance integration (F-04) | ☐ |
| WF-04 | Biometric device make, model and connectivity (photo) | All devices | Integration feasibility (F-04) | ☐ |
| WF-05 | **Photos of the allocation board or whiteboard**, or the allocation sheet | 1–2 weeks of days | Whether allocation is really a daily decision (F-07; assumption 5) | ☐ |
| WF-06 | Skills matrix, if any | 1 | Allocation constraints (F-08) | ☐ |
| WF-07 | Contractor list and how they bill (format only) | All | Contract labour model (F-02) | ☐ |
| WF-08 | Wage basis description (piece-rate or daily rules, **not individual pay**) | 1 | Scope boundary (F-06) | ☐ |

### AC — Accounting (through the accountant or CA)
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| AC-01 | Masters export: ledgers, groups, stock items, units | 1 | Chart-of-accounts mapping, Tally export design (I-04) | ☐ |
| AC-02 | Trial balance at the last fiscal year end and the latest month end | 2 | Cut-over planning (P-04) | ☐ |
| AC-03 | Receivables and payables outstanding, **bill by bill** | 1 each | Opening balances, ageing (G-09, P-04) | ☐ |
| AC-04 | Sample vouchers of each type used (sales, purchase, receipt, payment, journal, contra, debit/credit note) | 3–5 per type | Voucher mapping (I-03) | ☐ |
| AC-05 | Filed GSTR-1 and GSTR-3B summaries | Last 3 months | Reconciliation tests (I-07) | ☐ |
| AC-06 | A supplier-side GST data download (GSTR-2B), if reconciliation is done | 1–3 months | Reconciliation design (I-07) | ☐ |
| AC-07 | A bank statement **format sample** (redacted or a dummy) | 1 per bank | Bank import design (I-05) | ☐ |
| AC-08 | Expense vouchers and petty cash book pages | 1 month | Expense flow (I-06) | ☐ |
| AC-09 | Owner's management reports (MIS, Excel) | Latest 2–3 | Dashboard KPIs from real definitions (L-02) | ☐ |
| AC-10 | **A copy of the Tally company for import testing** (with the CA's agreement) | 1 | Tally export validation (Round 2 §7.2) | ☐ |

### QA — Quality
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| QA-01 | Inspection reports (incoming, in-process, final) | 5–10 each | Inspection model (J-01) | ☐ |
| QA-02 | Test certificates received and issued | 5–10 | Traceability (B-13) | ☐ |
| QA-03 | Customer complaint records | Last 6 months | Complaint flow (J-03) | ☐ |
| QA-04 | Rejection reason list | 1 | Reason codes (J-04) | ☐ |

### CM — Communication
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| CM-01 | List of work WhatsApp groups with purpose and member roles (**no message content**) | All | Notification and announcement design (K-01) | ☐ |
| CM-02 | Photos of notice boards | All | Announcement design (K-03) | ☐ |

### ST — Site, IT and infrastructure
| ID | Item | Target | Purpose | ☐ |
|---|---|---|---|---|
| ST-01 | Photos of the candidate server location, including power sockets and ventilation | 3–5 | Server placement (M-08) | ☐ |
| ST-02 | Router and network equipment photos, plus who has admin access | All | Split-horizon DNS feasibility (M-04) | ☐ |
| ST-03 | Wi-Fi signal readings at the office, stores, each bay, the gate and dispatch | 1 walk | Floor connectivity (M-05) | ☐ |
| ST-04 | Internet speed test at the office and on the floor | 3 readings | Remote access sizing (M-01) | ☐ |
| ST-05 | **Two-week internet outage diary** (template below) | 14 days | Validates the local-first assumption (§10.4, assumption 3) | ☐ |
| ST-06 | **Two-week power cut diary** (template below) | 14 days | UPS sizing and outage design (M-09) | ☐ |
| ST-07 | Existing PC specs (system info screenshots) | All candidate PCs | Hardware options (M-07) | ☐ |
| ST-08 | Printer makes, models and connections | All | Printing design (M-10) | ☐ |
| ST-09 | Phone models used by supervisors and workers | Sample of 10 | PWA performance budget (M-14) | ☐ |
| ST-10 | Domain registrar and DNS host for the company domain | 1 | Remote access setup (M-12) | ☐ |

### PM — Process maps (made during the visit)
| ID | Item | Purpose | ☐ |
|---|---|---|---|
| PM-01 | Order-to-cash, as-is, with people, documents, tools and timings | Sales and invoicing design | ☐ |
| PM-02 | Procure-to-pay, as-is | Purchasing and document AI design | ☐ |
| PM-03 | A production day, as-is (plan, allocate, run, record, report) | Production and allocation design | ☐ |
| PM-04 | Attendance and shift handover, as-is | Workforce design | ☐ |
| PM-05 | Month-end accounting, as-is | Accounting and CA pipeline | ☐ |

---

## Diary templates

### ST-05: internet outage diary (one line per outage)
| Date | Down from | Back at | Provider | What was affected | Noticed by |
|---|---|---|---|---|---|
| | | | | | |

### ST-06: power cut diary (one line per cut)
| Date | Cut from | Restored at | Backup used (UPS, inverter, generator) | Did PCs, router or Wi-Fi go down? | Noted by |
|---|---|---|---|---|---|
| | | | | | |

---

## Minimum viable collection
If time is short, collect at least these before the "Discovery Findings" document can be written:
- LG-01
- SL-01
- SL-08
- PU-01 (at least 50)
- IN-01
- PR-02
- MM-01
- WF-01
- WF-03
- WF-05
- AC-01
- AC-03
- AC-09
- ST-02
- ST-05
- ST-06
- PM-01 to PM-03
