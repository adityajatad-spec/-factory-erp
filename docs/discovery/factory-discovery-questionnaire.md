# Factory ERP — Factory Discovery Questionnaire

> **Deferred:** Factory discovery is deferred because the current build is a surprise prototype. These documents will be used later for real-world validation and factory-specific configuration.

**Version:** 0.1 (2026-10-05)
**Status:** awaiting approval for use (R2-D7)

**Purpose:** learn how this factory actually works before any business module is designed. Nothing in `docs/ARCHITECTURE.md` about workflows is treated as fact until this discovery confirms it.

**Use with:** [`data-collection-checklist.md`](data-collection-checklist.md)

---

## How to run discovery

### Who to interview, in this order
| # | Person | Time | Sections |
|---|---|---|---|
| 1 | Owner / MD | 60–90 min | A, L, N, O, P, Closing |
| 2 | Accountant (and the CA, by phone or in person) | 90 min | A, G (invoicing), H (bills and payments), I, P |
| 3 | Purchase and stores | 60 min | C, H |
| 4 | Production manager plus 1–2 supervisors | 90 min plus a floor walk | B, D, E, F (allocation), J |
| 5 | HR or time office | 45 min | F |
| 6 | Sales and dispatch | 45 min | G |
| 7 | 3–5 workers, informally on the floor | about 10 min each | F-09 to F-11, E-03, K |
| 8 | Whoever manages IT and the network | 45 min plus a site walk | M |
| 9 | Gate and security | 15 min | H-05, G-05 (inward and outward registers) |

### Observation tasks (as important as the interviews)
- [ ] Follow **one customer order** from inquiry to payment received.
- [ ] Follow **one purchase** from need to bill entry to payment.
- [ ] Watch a **shift change**: how instructions and production numbers are handed over.
- [ ] Watch **attendance capture** at the start of a shift.
- [ ] Watch a **dispatch**: challan, invoice printing, e-way bill, gate exit.
- [ ] Watch **material issue** from stores to production.
- [ ] Record **phones in use** on the floor: models, whether they're used for work, and whether they're allowed.
- [ ] **Check Wi-Fi signal** with a phone at the office, stores, each production bay, the gate and the dispatch area.
- [ ] Photograph the **candidate server location**, the router and network gear, and the printers (with permission).

### How to record answers
- Copy this file for each visit and write answers under each question.
- Tag every answer with how you know it:
  - **[T]** told
  - **[O]** observed
  - **[D]** seen in a document, plus the checklist ID
- Prefer O and D over T.
- Record **volumes and frequencies** (per day, week or month), **who** does it, the **tool** used (paper, Excel, Tally, WhatsApp), **what goes wrong**, and **current workarounds**.

### Interview rules
- Ask **"show me the last one"** rather than "how does it usually work?"
- Don't propose solutions during the interview. Note ideas separately.
- Ask "what happens when it goes wrong?" for every process.
- Never collect individual salaries, Aadhaar numbers or bank account numbers during interviews.

---

## A. Company and legal
*Why: this determines tax treatment, numbering, compliance integrations and multi-entity needs.*

- **A-01** What is the legal entity type: proprietorship, partnership, LLP, private limited or other? Does any other entity under the same ownership trade with this factory?
- **A-02** How many GSTINs are there? For each: state, registered address, and additional places of business.
- **A-03** What is the GST registration type: regular or composition? Is any change planned?
- **A-04** What was the aggregate turnover band in each of the last two financial years? Ranges are fine.
- **A-05** Is e-invoicing (IRN/QR) used today? Since when, and through which software or portal?
- **A-06** Are e-way bills generated today? How many a month, by whom, and with what tool?
- **A-07** Are there exports, SEZ customers, deemed exports or imports? Is an LUT in place?
- **A-08** Is the business Udyam (MSME) registered? Which category?
- **A-09** How many plants, warehouses and offices are there? Where are they, and how far apart?
- **A-10** Do any branches or units keep separate books? Do statutory audit and tax audit apply?
- **A-11** Are there certifications (such as ISO 9001) or customer requirements that impose documentation?
- **A-12** Do any customers require their own portal, an ASN or EDI?

## B. Products and manufacturing process
*Why: this shapes the production, BOM, inventory and units model. Nothing here is assumed.*

- **B-01** What does the factory make? List the product families with examples.
- **B-02** How many active finished-goods SKUs are there? How often are new ones created?
- **B-03** Make-to-order, make-to-stock, or both? Roughly what share each?
- **B-04** Are products customer-specific (drawings or specs) or catalogue items?
- **B-05** Draw the production process step by step for the top 3 products. Which steps happen on which machines?
- **B-06** Is production discrete (countable pieces), batch (mixes, heats, lots) or continuous?
- **B-07** Do bills of materials exist (on paper, in Excel, or in people's heads)? Who maintains them, and how accurate are they?
- **B-08** What units are used for raw materials, WIP and finished goods (kg, pcs, metres, sheets, litres)? Where do conversions happen, for example buying in kg, using in pcs and billing per kg?
- **B-09** Is weight recorded? Where are the weighing scales or weighbridge? Is billing by weight or by count?
- **B-10** What scrap and by-products are generated? Are they recorded? Sold?
- **B-11** How common are rework and rejects, and how are they recorded?
- **B-12** **Job work:** do you send material out (plating, heat treatment, machining) or do job work for others? What are the volumes, and which documents are used?
- **B-13** Do customers need traceability: batch or heat numbers, test certificates, serial numbers?
- **B-14** What is printed on packages and labels? Are barcodes or QR codes used?
- **B-15** Is there seasonality? When are the peak months?

## C. Raw materials and inventory
- **C-01** What are the top 20 materials or components by spend? Give the unit and a typical order quantity for each.
- **C-02** How many distinct items are stocked in total (raw materials, consumables, spares, packing)?
- **C-03** Where is stock stored? How many stores or locations? Is there a dedicated storekeeper?
- **C-04** How is material issued to production? Is there an issue slip or register? Who authorizes it?
- **C-05** How is current stock known today (register, Excel, Tally, memory)? How accurate is it?
- **C-06** When was the last physical stock count? How often are counts done? How big were the differences?
- **C-07** How are reorder decisions made? Are there minimum levels? What are the lead times for key materials?
- **C-08** Does stock ever go "negative" in the records (issued before the receipt was entered)? How is that handled?
- **C-09** Are batches, lots or heat numbers tracked for any material?
- **C-10** How is stock valued for the books today (method), and who decides?
- **C-11** Is there known dead or slow-moving stock? Roughly how much?
- **C-12** Are consumables and spares tracked as stock, or expensed on purchase?
- **C-13** Do customers supply material (free issue)?

## D. Machines and maintenance
- **D-01** List the machines and workstations: name or number, type, make and model, year, location, and whether each is critical. (Checklist item MM-01)
- **D-02** Which machines are the bottlenecks?
- **D-03** Do machines have counters, PLCs, meters or any data output? Any network connectivity?
- **D-04** How are breakdowns reported today? Who fixes them, in-house or a vendor? What is the typical time to repair?
- **D-05** Is downtime recorded with start, end and reason? Where?
- **D-06** Is there a preventive-maintenance schedule or checklists? Who follows up?
- **D-07** Are spare parts stocked and tracked? Is there a critical-spares list?
- **D-08** What AMCs and vendor contracts exist, and who are the contacts?
- **D-09** Are utilities tracked: compressor, generator set, boiler and so on?
- **D-10** Are tooling, dies and moulds tracked separately? Is tool life tracked?

## E. Production planning and recording
- **E-01** How does a customer order become a production plan? Who decides what runs on which machine today?
- **E-02** Is there a written daily or weekly plan? In what format? (Collect one: PR-01.)
- **E-03** What is recorded per shift: good and rejected quantity, machine, operator, hours, material used, downtime? Who records it, where, and when?
- **E-04** Are there targets per machine, operator or shift? How are they set?
- **E-05** Are cycle times or standard outputs known per product per machine?
- **E-06** How and when does management find out yesterday's production? In what form?
- **E-07** Are work orders or job cards used? (Collect one: PR-03.)
- **E-08** How is WIP tracked between stages?
- **E-09** Are piece-rate or incentive schemes tied to production records?
- **E-10** What are the most common causes of lost production? Ask the owner and the supervisors separately.
- **E-11** Who supervises and records the night shifts?

## F. Workforce, shifts and attendance
- **F-01** What is the headcount by department? How many are permanent, contract, trainee or apprentice?
- **F-02** How many labour contractors are used? How are contract workers' attendance and payments handled?
- **F-03** What are the shift timings, rotation pattern, breaks and weekly offs? How does overtime work?
- **F-04** How is attendance captured: biometric (make and model?), register or app? Who reconciles it? Can the data be exported?
- **F-05** How does the leave process work?
- **F-06** What is the wage basis: daily, monthly or piece-rate? Who calculates payroll, and with what software? *(Do not collect individual salaries.)*
- **F-07** **Allocation:** how are workers assigned to machines or tasks each day? Who decides, and how long does it take? Which constraints matter: skills, certifications, seniority, machine requirements, absentees? What goes wrong?
- **F-08** Is there a skills matrix showing who can run which machine?
- **F-09** **Are phones allowed on the shop floor?** For whom? Are there safety or quality rules?
- **F-10** What share of workers and supervisors have smartphones? Android or iPhone? Mobile data? How comfortable are they with apps?
- **F-11** Which languages are spoken and read on the floor? Are there literacy considerations?
- **F-12** How many supervisors are there? What are their responsibilities, and what tools do they use now (registers, WhatsApp)?
- **F-13** Who handles statutory compliance (PF, ESI, professional tax)? *(Asked for scope boundaries only.)*
- **F-14** How are safety incidents recorded?

## G. Sales and customers
- **G-01** How many active customers are there? What share of revenue do the top 10 bring?
- **G-02** What are the steps from inquiry to quotation to order: people, documents, tools? Show examples.
- **G-03** Do customers send formal POs? In what formats (PDF, email, portal)? How are they tracked?
- **G-04** How is pricing set: price lists, customer-specific rates, rate contracts, per-kg pricing, metal-price-linked pricing, discounts?
- **G-05** How does dispatch work? Who decides? Which documents are produced (delivery challan, packing list, e-way bill, gate pass)? How are transporter and vehicle details recorded?
- **G-06** **Invoicing:** who creates invoices, and when (before or after dispatch)? In what software? Are there approvals? How many per day and per month? How are they printed (printer type, number of copies, pre-printed stationery)? How do they reach the customer?
- **G-07** Which numbering series are used, and in what format? Are there separate series for export, job work or scrap?
- **G-08** How often are credit or debit notes issued, and why (returns, rate differences, quality claims)?
- **G-09** What are the credit terms per customer? How is outstanding tracked? Who follows up, and how (calls, WhatsApp)?
- **G-10** Which payment modes come in (NEFT/RTGS, UPI, cheque, cash)? How are receipts matched to invoices?
- **G-11** Do customers pay advances?
- **G-12** How are scrap sales invoiced?
- **G-13** How are sales returns handled?
- **G-14** What is the biggest pain in sales, dispatch or invoicing?

## H. Purchasing and suppliers
- **H-01** How many active suppliers are there? Who are the top 10 by spend?
- **H-02** How is a purchase need identified (stores, production, owner)? Who approves it? Are there value limits?
- **H-03** Are formal POs issued, or are orders placed by phone or WhatsApp? Show examples.
- **H-04** Are quotations collected and rates compared?
- **H-05** What happens at the gate on receipt: inward register, GRN, weighbridge? Who checks quantity and quality?
- **H-06** Which materials get incoming inspection? Who does it, and where is it recorded?
- **H-07** **Supplier bills:** how do they arrive (with the goods, email, WhatsApp, courier)? What is the format mix (printed, handwritten, PDF, e-invoice), approximately in %? How many per month?
- **H-08** Who enters bills, and into what? How long does each bill take? What errors are common?
- **H-09** Is each bill checked against the PO and the receipt? By whom?
- **H-10** How are payments decided: what gets paid when, approvals, payment modes? **How are supplier bank details stored and changed?**
- **H-11** Is TDS deducted on any purchases or services? *(Scope only.)*
- **H-12** Are MSME-registered suppliers identified? Are their payment timelines tracked?
- **H-13** How are freight and transport bills handled?
- **H-14** What is the biggest pain in purchasing?

## I. Accounting and finance
- **I-01** Which accounting software and version is used? Single-user or multi-user? Where is it installed, and who has access?
- **I-02** Who does what: the in-house accountant versus the CA? How often is the CA involved?
- **I-03** Which vouchers are entered in-house, and which by the CA's office?
- **I-04** What ledgers and groups make up the chart of accounts? Are cost centres used?
- **I-05** How many bank accounts are there? Payment gateways or UPI? How are cash and petty cash handled?
- **I-06** Who records expenses, how, and with what receipts?
- **I-07** Who prepares GST returns, and from what data? Is purchase data reconciled against the supplier-side data, and how?
- **I-08** What are the month-end and year-end processes, and how long do they take? Which audits apply?
- **I-09** What reports does the owner get from accounts (P&L, outstanding, cash)? How often, and in what format?
- **I-10** Is inventory kept in the accounting software? How accurate is it?
- **I-11** Would the CA accept data imported into Tally from another system? Any preferences on format or granularity?
- **I-12** **Will the CA review test cases and sign off calculations?** What availability and fees?
- **I-13** When should cut-over happen: start of a fiscal year, quarter or month?
- **I-14** Have there been any GST notices, mismatches or penalties that point to process weaknesses?
- **I-15** What is the biggest accounting pain?

## J. Quality
- **J-01** Where are the inspection points (incoming, in-process, final)? What parameters are measured, and with which instruments?
- **J-02** What records are kept (registers, reports, test certificates)? Who signs them?
- **J-03** How are customer complaints logged and closed?
- **J-04** Is there a list of rejection reasons, formal or informal?
- **J-05** Do certifications or customer audits impose requirements on records?

## K. Communication and tasks
- **K-01** Which WhatsApp groups are used for work? What is each one for, and who is in it? *(No message content.)*
- **K-02** How are instructions passed between shifts and between departments?
- **K-03** How are announcements made: notice boards, groups, meetings?
- **K-04** How are follow-ups and tasks tracked?
- **K-05** Which events must reach whom immediately (breakdown, rejection, payment received, material shortage)?
- **K-06** Would people accept notifications in an app, or must it be WhatsApp?

## L. Management reporting and decisions
- **L-01** What decisions does the owner make daily, weekly and monthly?
- **L-02** What numbers does the owner check today, how, and how often? Show the latest report.
- **L-03** What would they like to know that they can't find out today?
- **L-04** Rank the top 5 pains across the business.
- **L-05** What would make V1 a success in 90 days? What would make them stop using it?
- **L-06** Who else needs to see management numbers (partners, bank, family)?

## M. IT, network, power and devices
- **M-01** Which internet providers are used? Plan speeds and connection type? Is there a static IP?
- **M-02** How often does the internet go down, and for how long? Estimate now, then confirm with the 2-week diary (ST-05).
- **M-03** Is there a backup internet connection (4G/5G router or dongle)?
- **M-04** What is the router make and model? **Who has the admin password? Can DNS and DHCP settings be changed?**
- **M-05** How many Wi-Fi access points are there, and where? What does the floor coverage walk test show? Is there interference (metal sheds)?
- **M-06** What network switches and cabling exist? Is there a network diagram?
- **M-07** How many PCs are there, with what OS, specs and age? Who uses them? Is antivirus installed? Are logins shared?
- **M-08** **Candidate server location:** dust, heat, ventilation, physical security, power sockets, earthing. Is it lockable?
- **M-09** How often does the power go, and for how long? Is there an inverter, UPS or generator, and how long is the changeover? **Are the router, switches and access points on backup power?**
- **M-10** What printers are there (laser, inkjet, dot-matrix, thermal label)? Models, how they're connected, and what each one prints.
- **M-11** Who manages IT today, staff or a vendor? How quickly do they respond?
- **M-12** **Who owns the company domain name and controls its DNS?** Which email provider is used?
- **M-13** What software licences and subscriptions exist today?
- **M-14** What range of phone models do staff use on site? *(For performance testing.)*
- **M-15** Are there other on-site servers or devices (NVR/CCTV, NAS)?

## N. Security and data access
- **N-01** Who should see what: salaries, cost prices, margins, customer lists, supplier rates, bank balances?
- **N-02** Who needs remote access, from where, and for what?
- **N-03** Are there concerns about data leaving the premises (cloud backups, cloud AI)?
- **N-04** Is it acceptable to use a company app on personal phones?
- **N-05** Have there been past incidents: data loss, virus or ransomware, fraud, theft?
- **N-06** Who approves new users and permission changes?

## O. AI expectations
- **O-01** Which tasks would they most like help with? Collect their examples, not ours.
- **O-02** What language would they use to ask questions? Voice or typing?
- **O-03** How comfortable are they with AI drafting documents that a person then confirms? Is there any task they'd never trust to AI?
- **O-04** Which data may be sent to cloud AI services? Ask per type: purchase bills, sales invoices, employee data, financial reports.
- **O-05** Would a daily summary (WhatsApp or PDF) be more useful than a chat assistant?

## P. Data, migration and cut-over
- **P-01** What data exists digitally today: accounting masters and vouchers, Excel sheets (list them), other software?
- **P-02** How much history should come across: none, the current fiscal year, or two years?
- **P-03** How good is the master data: duplicates, naming conventions, GSTINs missing for parties?
- **P-04** Are opening balances available: party-wise outstanding (bill by bill) and stock by item and location?
- **P-05** Who will own master data from now on?
- **P-06** What timing and constraints apply to cut-over (busy seasons, audits)?

## Closing
- **Z-01** In one sentence, what does success look like for the owner?
- **Z-02** Who will be the internal champion, with time set aside for this?
- **Z-03** Who on site can physically attend to the server (restart, check lights, swap a disk under guidance)?
- **Z-04** Who makes scope decisions when people disagree?
- **Z-05** Who is available for follow-up questions, and how should we reach them?

---

## After discovery
The answers and collected documents feed a **"Discovery Findings & V1 Scope"** document containing:
- process maps (as-is)
- confirmed workflows
- volumes
- pain ranking
- validation results for the product assumptions in Architecture Round 2 §10.4
- the V1 module cut and order
- the regulatory items V1 depends on
- a hardware and network recommendation
- open questions
