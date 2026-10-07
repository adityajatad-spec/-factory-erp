# Factory ERP — Factory Discovery Pack

> **Deferred:** Factory discovery is deferred because the current build is a surprise prototype. These documents will be used later for real-world validation and factory-specific configuration.

**Version 1.0 · 2026-10-05 · For use on site**

**Goal:** find out how this factory *really* works by watching the work and collecting real paperwork. We design nothing until this is done.

**Priority:** MUST items can change the architecture or the V1 scope, so get them first. HIGH VALUE items sharpen V1. NICE TO HAVE items help later modules.

**Reference documents** (not needed on site): the full questionnaire (`factory-discovery-questionnaire.md`) and the checklist (`data-collection-checklist.md`). Document IDs such as `SL-01` are the same in all three.

---

## 0. Before the visit

- ☐ **Get the owner's written consent**, with three separate tick boxes:
  - (a) collect copies of business documents
  - (b) use them to test document-reading accuracy
  - (c) send any sample to a cloud AI service. The default for this one is **NO**.
- ☐ **Pick the visit days.** Include a normal production day and a shift change. Avoid month-end, audits and peak dispatch days.
- ☐ **Brief the accountant a few days ahead** to prepare the Tally exports in §3 (TX). Exports take time.
- ☐ **Get names from the owner:** an internal champion, the accountant, the CA contact, the production manager, someone who looks after IT, and a gate/security contact.
- ☐ **Start the internet and power diaries (§7)** 14 days around the visit. Leave the sheets in the office.
- ☐ **Create the encrypted folder (§6) outside the code repository.** Samples never go into git.
- ☐ **Bring:**
  - this pack, printed
  - a phone with a camera, a Wi-Fi signal app, a speed-test app and a stopwatch
  - an encrypted USB drive
  - sticky labels and a marker
  - a notebook

---

## 1. Locking facts sheet — fill this in before you leave the factory

Facts **F1–F17 decide the architecture and the V1 scope.** For each answer, mark how you know it: **[T]** told, **[O]** observed, **[D]** seen in a document.

| # | Fact to establish | Answer | T/O/D | What it changes |
|---|---|---|---|---|
| F1 | Entity type. Number of GSTINs, states, plants and warehouses. | | | Multi-company in V1, compliance rules |
| F2 | GST scheme (regular or composition) and turnover band (a range is fine) | | | Which invoice rules and e-invoice rules apply |
| F3 | Are e-invoices (IRN/QR) made today? How many e-way bills per month? | | | E-invoice integration in V1. A backup internet link becomes mandatory. |
| F4 | Exports or SEZ? Job work sent out, or done for others? | | | Extra invoice and challan types and rules |
| F5 | Tally edition and version, single- or multi-user, and who enters which vouchers | | | Tally export design |
| F6 | Will the CA review our test calculations and accept vouchers imported into Tally? | | | Whether the accounting validation plan works |
| F7 | Production type (discrete pieces, batch or continuous). Units used. Is billing by weight or by count? | | | Production and inventory model, unit conversions |
| F8 | **Monthly volumes:** sales invoices, purchase bills (split by printed, handwritten, PDF and e-invoice), POs, active items, employees, system users, machines | | | Sizing. Whether document AI is worth building early. |
| F9 | Are phones allowed on the floor? What % of supervisors and workers have smartphones? Which languages do they read? Are devices shared? | | | Phone app vs shared tablet vs supervisor desk. Offline design. Language. |
| F10 | Internet outages per week and how long they last. Is there a backup link? | | | Whether local-first is justified |
| F11 | Power cuts per day and how long they last. Are the router, switches and Wi-Fi on UPS or inverter? | | | UPS sizing, and whether the LAN survives a power cut |
| F12 | Router make and model. Who has admin access? Can DNS and DHCP be changed? | | | Feasibility of one address for LAN and remote access (R2-D2) |
| F13 | Domain: who owns it and where its DNS is hosted. Does the ISP give a public IP, or is it CGNAT? | | | Remote-access provider (R2-D6) |
| F14 | Who needs remote access, and from where? Comfort with data passing through a cloud provider or cloud AI. | | | Remote-access choice, AI policy |
| F15 | How are workers assigned to machines today, by whom, and how often does it change? | | | Whether workforce allocation belongs in V1 at all |
| F16 | Top 3 pains as the owner, the accountant and production each see them | | | V1 module order |
| F17 | Candidate server location and any existing PC that could be used | | | Hardware plan, AI capability |

---

## 2. Priorities at a glance

| Tier | What it covers |
|---|---|
| **MUST HAVE before the architecture is locked** | F1–F17 answered. Sales invoices, the current invoice template, purchase bills (printed and handwritten), production records, item master and stock summary, the employee list with shifts, allocation evidence, the owner's reports, Tally exports and site/IT evidence. Whether POs, challans, job work and attendance exports exist, even if no samples are taken. |
| **HIGH VALUE** | More bill samples for the AI test set, POs, challans, credit and debit notes, attendance exports, machine and breakdown records, stock registers and counts, BOMs, GST return summaries, Excel copies, PC and printer details |
| **NICE TO HAVE** | Quality records, preventive-maintenance and AMC documents, spares lists, quotations, the WhatsApp group list, notice boards, the org chart, history older than the current financial year |

---

## 3. Documents to collect

- **Min** means the minimum to lock the architecture. **Target** means the full useful set.
- Tick each variation as you collect it. A variation that doesn't exist at this factory is useful information too, so mark it **"N/A"**.
- **Photograph every paper document twice:**
  - **(a) clean:** flat, good light, the whole page
  - **(b) as received:** the way staff actually get or send it, such as a WhatsApp-forwarded photo or an angled shot
- **Record exports as files.** Don't photograph a screen if an export is possible.

### MUST HAVE

**SL-01 Sales invoices · Min 25 · Target 40**
Collect 2–3 of each variation that exists:
- ☐ Within the state (CGST + SGST)
- ☐ To another state (IGST)
- ☐ To an unregistered or B2C customer
- ☐ Two or more different GST rates on one invoice
- ☐ Discount on a line or on the whole invoice
- ☐ Freight, packing or other charges
- ☐ Billed per kg (weight)
- ☐ Billed per piece (count)
- ☐ A long invoice (15+ lines or several pages)
- ☐ Last invoice of March and first of April (numbering across the financial year)
- ☐ Top 5 customers plus 3 small customers
- ☐ A cancelled invoice
- ☐ Export or SEZ (if any)
- ☐ Scrap sale (if any)
- ☐ Job-work charges (if any)
- ☐ **One complete printed set** with all copies as physically printed (original, duplicate, triplicate), plus the software's PDF of the same invoice

**SL-08 Current invoice templates · 1 of each format in use**
- ☐ The software's print or PDF of every format: tax invoice, export, job work, credit note, delivery challan, proforma or quotation
- ☐ A photo of blank **pre-printed stationery** (if used), plus one filled sheet
- ☐ The logo file at original quality, how the signature and stamp are applied, the bank-details block, and the terms and declarations text
- ☐ A photo of the invoice printer's model label and the number of copies printed
- ☐ What staff and the owner **dislike** about the current invoice

**SL-02 and SL-05 E-invoices and e-way bills (only if used) · 5 each**
- ☐ E-invoices printed with the QR code visible
- ☐ E-way bills
- ☐ A cancelled one (if any)

**PU-01a Purchase bills: printed, PDF and e-invoice · Min 50 · Target 120**
- ☐ The top 15 suppliers, 2–3 bills each
- ☐ Laser-printed bills
- ☐ Dot-matrix or carbon-copy bills
- ☐ PDFs received by email
- ☐ E-invoices with QR
- ☐ Multi-page bills
- ☐ Within the state and from another state
- ☐ Bills with several GST rates
- ☐ Bills with freight
- ☐ Transport or truck bills
- ☐ Service bills (repair, AMC)
- ☐ **Paired ground truth for 20 bills:** a screenshot or printout of how each was entered in Tally
- ☐ 5 "problem" bills (wrong rate, disputed, duplicate) and what happened

**PU-01b Handwritten and local bills · Min 20 · Target 50**
This tells us whether AI can realistically read them or whether they stay manual entry.
- ☐ Local hardware or consumables shop
- ☐ Transporter or tempo
- ☐ Labour contractor
- ☐ Scrap buyer or seller
- ☐ Canteen or petty purchases
- ☐ Local fabricator or job worker
- ☐ With a GSTIN, and without one
- ☐ An "estimate" or kachha slip, and a proper bill
- ☐ Different handwriting
- ☐ Carbon copies
- ☐ Stamped bills
- ☐ Mixed languages (English, Hindi, regional)
- ☐ **Paired entry for 10:** how each was recorded, if it was recorded at all

**PR Production records**
- ☐ **PR-02 Shift production registers or sheets:** every page for **10 consecutive working days**, all departments (min). Target: one full month.
  - ☐ Day and night shift
  - ☐ A day with a breakdown
  - ☐ A day with high rejects
- ☐ **PR-01 Daily or weekly production plan:** 2 weeks, if one exists. If not, record how the day's plan is communicated.
- ☐ **PR-04 BOM, recipe or material-per-piece sheets** for the top 5 products. If none exist, write "none" and note where that knowledge lives.
- ☐ **PR-05 Process flow sketch** for the top 3 products, drawn with the production manager

**IN Stock records**
- ☐ **IN-01 Item master export:** all items, with code, name, unit, HSN and group
- ☐ **IN-02 Latest stock summary** (quantity by item and by location)
- ☐ **IN-05 Unit conversions in use**, for example kg ↔ pcs or sheet ↔ kg

**WF Employee, shift and allocation records**
- ☐ **WF-01 Employee list:** code, department, designation, permanent / contract / trainee, shift, and "has smartphone?" Use **codes instead of names** if preferred. **No Aadhaar, bank details or salaries.**
- ☐ **WF-02 Shift timings and roster:** the current one plus one week where it changed
- ☐ **WF-05 Allocation evidence:** photos of the allocation board or sheet for **10 working days**. If allocation is decided verbally, write that down and observe it on Day 2.
- ☐ **WF-04 Attendance method:** a photo of the biometric device's make and model label and how data comes out of it (USB, network or software), or a photo of the register

**AC-09 Existing reports · Latest 2 of each report the owner uses**
Covers MIS, Excel sheets, WhatsApp summaries and Tally reports.
- ☐ For each one, note who makes it, how long it takes and **which decision it drives**. This becomes the real dashboard KPI list.

**TX Tally and Excel exports**
- ☐ A screenshot of the Tally edition and version
- ☐ Masters export: ledgers and groups, stock items, units, godowns
- ☐ Sales register and purchase register for **one recent full month**
- ☐ Bill-wise **outstanding receivables and payables**
- ☐ Trial balance at the latest month end
- ☐ **A list of every Excel sheet used to run the business**: name, owner and purpose

**ST Site and IT evidence**
- ☐ 14-day internet and power diaries (§7)
- ☐ Photos of the router and network gear, plus who holds the admin password (don't write the password down)
- ☐ Wi-Fi signal readings at the office, stores, each production bay, the gate and dispatch
- ☐ Speed tests in the office and on the floor
- ☐ Photos of the candidate server location: dust, heat, ventilation, power sockets, whether it can be locked
- ☐ Phone models of 10 random staff (supervisors and workers)
- ☐ Domain registrar and DNS host for the company domain

### HIGH VALUE

**PU-02 Purchase orders · Min 5 · Target 15**
- ☐ Formal POs: a multi-line PO, a PO with negotiated rates and terms, a revised or amended PO, a PO received in partial deliveries
- ☐ **If POs aren't used:** 5–10 screenshots of WhatsApp or phone orders (redact personal numbers), plus any indent or requisition slips

**SL-06 Customer POs received · 5–10**
- ☐ From different customers and in different formats (PDF, email, portal printout)

**SL-04 and PU-06 Delivery challans and gate documents · Min 5 · Target 15**
- ☐ Sales delivery challans (5)
- ☐ Job work sent out and returned (3 each, if any)
- ☐ Returnable challans, for example tools or moulds sent for repair (2)
- ☐ Transfers between locations (2, if any)
- ☐ Gate pass or inward/outward register: 1 week
- ☐ Weighbridge slips (5)
- ☐ Packing lists (3)

**SL-03 Credit and debit notes · Min 3 · Target 8**
- ☐ Return
- ☐ Rate difference
- ☐ Quality claim
- ☐ Discount given after the sale

**PU-01 more bills.** Grow the combined printed and handwritten bill set towards **150–200**, keeping the variation mix above. This becomes the AI accuracy test set.

**WF-03 Attendance data · 1 month**
- ☐ The **raw biometric export file**, not only a printed report, or the register pages
- ☐ It must include overtime, a night shift, leave or absence, a late arrival, a manual correction, and contract workers
- ☐ The monthly summary sent to payroll or the CA

**WF-06 and WF-07 Workforce details**
- ☐ Skills matrix (who can run which machine), if one exists
- ☐ Labour contractor list and how they bill (format only)

**MM Machine records**
- ☐ **MM-01 Machine list:** name or number, make, model, year, location, critical (Y/N), and whether it has a counter or PLC
- ☐ **MM-02 Nameplate photos** of the critical machines
- ☐ **MM-03 Breakdown or maintenance register:** 3–6 months

**PR Production, more**
- ☐ **PR-03 Job cards or work orders:** 5–10
- ☐ **PR-06 Rejection, rework and scrap register:** 1 month
- ☐ **PR-07 Downtime notes:** 1 month, if any are kept
- ☐ **PR-08 Targets and cycle times**, if known
- ☐ **PR-04 BOMs** for the top 10 products

**IN Stock, more**
- ☐ **IN-02 Stock register or bin cards** for 10 items (5 fast-moving and 5 slow), 1 month
- ☐ **IN-04 Material issue slips:** 2 weeks
- ☐ **PU-03 Inward register or GRN:** 2 weeks
- ☐ **IN-03 Last physical count sheet** and the differences found

**AC Accounting, more**
- ☐ GSTR-1 and GSTR-3B summaries for 3 months
- ☐ 3 sample vouchers of each type used
- ☐ Copies of the **top 5 Excel sheets**
- ☐ Agreement in principle from the CA that a **copy of the Tally company** can be used for import testing later

**SL-07 Price lists and rate contracts**, all that are current.

**ST-07 and ST-08 IT details**
- ☐ Specs of candidate PCs (system-info screenshot)
- ☐ Printer models and how each is connected

### NICE TO HAVE
- ☐ **QA-01 to QA-04:** inspection reports, test certificates, complaint log, rejection-reason list
- ☐ **MM-04 to MM-06:** preventive-maintenance checklists, AMC contracts, spares list
- ☐ **SL-06:** quotations
- ☐ **CM-01 and CM-02:** list of work WhatsApp groups (**names, purpose and member roles only, no message content**), notice board photos
- ☐ Org chart, safety incident register, store layout sketch (IN-06), dead-stock list
- ☐ History older than the current financial year

**Do not collect:**
- individual salaries
- Aadhaar or PAN of individuals
- personal bank account numbers
- passwords
- WhatsApp message content
- CCTV footage

---

## 4. Interview and observation plan (2 days on site)

Adjust the times to the factory's shift timings. **"Show me the last one"** beats "how does it usually work?"

### Day 1 — office and overview
| Time | Who | Duration | Focus | Collect or observe |
|---|---|---|---|---|
| 09:00 | **Owner** | 75 min | F1, F2, F14, F16, F17. What success in 90 days looks like. What reports they use and the decisions those reports drive. Remote access needs. AI expectations, and what data may leave the premises. **Consent form.** | AC-09 reports, consent |
| 10:30 | Production manager | 60 min walk | A walk around the whole floor: stages, machines, boards, registers | Photos, allocation board, MM-01 starter |
| 11:30 | **Accountant** | 90 min | F3, F5, F6, F8 volumes, month-end routine, GST filing, pain points | **Watch and time:** entering 3 printed bills and 2 handwritten bills, and creating and printing 1 sales invoice. TX exports, SL-01, SL-08, PU-01. |
| 14:00 | Purchase and stores | 60 min | How a need becomes an order, gate entry, inspection, material issue, stock counts, reorder | PU-02, PU-03, IN records. Watch one goods receipt if one happens. |
| 15:00 | Sales and dispatch | 45 min | From order to dispatch to invoice, challans, e-way bill, collections | Watch one dispatch and invoice print. SL-04, SL-06. |
| 16:00 | HR or time office | 45 min | Attendance method and export, shifts, contract labour, leave | WF-01, WF-02, WF-03, WF-04 |
| 16:45 | Whoever handles IT | 45 min walk | F10–F13. Router, network gear, Wi-Fi, server location, printers | Wi-Fi readings, speed tests, ST photos |

### Day 2 — the floor and the shift
| Time | Who | Duration | Focus | Collect or observe |
|---|---|---|---|---|
| Shift start, e.g. 07:30 | Supervisors | 60 min | **Watch attendance capture and allocation (F15):** who decides who works where, how long it takes, what happens with absentees | Allocation board photo, attendance in action |
| 08:30 | Shadow 1–2 supervisors | 2.5 h | What gets written during the shift, when and by whom. How rejects and downtime are recorded. | PR-02 pages. Note every re-entry of the same data. |
| During the shift | **3–5 workers** (informal, with the supervisor's OK) | 5 min each | F9: smartphone? used at work? language read best? what gets written down? what slows them down? | Phone models |
| 11:00 | **Production manager** | 60 min | F7, planning, BOMs, rejects, downtime causes, targets and cycle times | PR-01, PR-04, PR-05 sketch |
| 12:00 | Maintenance | 30 min | Breakdown reporting, repair, preventive maintenance, spares | MM-02, MM-03 |
| 14:00 | Quality (if a separate person) | 30 min | Inspection points, records, complaints | QA items |
| Shift change | Outgoing and incoming supervisor | 30 min | **Watch the handover:** what's passed on, and in what form | Photos |
| 16:00 | Gate or security | 15 min | Inward and outward registers, gate passes, weighbridge | Register photos |
| 16:30 | **Owner wrap-up** | 30 min | Read back the **Locking facts sheet (§1)**, fill gaps, agree dates for the remaining documents | Signed-off sheet |

### Four trails to follow end to end
For each trail, note every person, every document, every time the same data is typed again, waiting time, and how errors get caught.

- **T1 One customer order:** inquiry or PO → production → dispatch → invoice → payment received
- **T2 One purchase:** the need → order → gate → stores → bill → entry → payment
- **T3 One shift:** plan → allocation → production → rejects and downtime → recording → report to management
- **T4 Month-end**, by interview with the accountant: what happens on each day

### Baseline timings to measure (these become V1 success measures)
| Task | Times observed | Avg |
|---|---|---|
| Enter one **printed** purchase bill (×3) | | |
| Enter one **handwritten** bill (×2) | | |
| Create and print one sales invoice (×2) | | |
| Compile yesterday's production report | | |
| Decide the day's worker allocation | | |
| Reconcile monthly attendance (ask) | | |
| Owner gets the total outstanding receivables (ask, or watch) | | |

### Interview rules
- Don't propose solutions or promise features on site.
- Ask "what happens when it goes wrong?" for every process.
- Tag every answer **[T]**, **[O]** or **[D]**.
- Prefer seeing over hearing.

---

## 5. Remote-access evaluation inputs (R2-D6, not locked)

These inputs let us compare Cloudflare Tunnel with the alternatives after the visit: a mesh VPN, or a self-hosted relay on a small cloud server.
- ☐ Domain registrar and current DNS host. Is the owner willing to move DNS hosting? Some tunnel services need it; this must be checked per provider.
- ☐ ISP details: public or static IPv4 available, or CGNAT? Is IPv6 available?
- ☐ Remote users: how many, which roles, and from where (home, travel, another plant)
- ☐ The owner's view on a third-party edge service seeing decrypted traffic
- ☐ Tolerance for a small monthly fee
- ☐ Who approves our support and admin access, and under what conditions

---

## 6. Handling, labelling and storage

- **Copies only.** Photos, scans or exports, never originals.
- **Redact** Aadhaar, personal bank account numbers, salaries and personal phone numbers. Business documents may stay unredacted only with the owner's consent.
- **Label** each item with its ID, sequence number and variation, for example `SL-01-07_2026-10-12_interstate-IGST.jpg`. Put a sticky label on any paper copy.
- **Log** every item in `collection-log.xlsx`. Columns: ID, description, variation, source person, date, redacted (Y/N), consent scope (a/b/c).
- **Store everything encrypted, outside the code repository,** in a folder named `FactoryERP-Discovery/` with these subfolders:
  `00-consent-and-log` · `01-sales` · `02-templates` · `03-purchase-printed` · `04-purchase-handwritten` · `05-orders-challans` · `06-production` · `07-stock` · `08-workforce` · `09-machines` · `10-reports` · `11-tally-excel` · `12-site-it` · `13-notes-photos`

---

## 7. Diary sheets (print and leave in the office for 14 days)

**Internet outages**

| Date | Down from | Back at | Provider | What was affected | Noted by |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |

**Power cuts**

| Date | Cut from | Restored at | Backup used (UPS, inverter or generator) | Did the PCs, router or Wi-Fi go down? | Noted by |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |

---

## 8. After the visit

Bring back three things:
- the **Locking facts sheet** (§1)
- the **baseline timings** (§4)
- your notes and the encrypted folder, limited to what the owner consented to share, redacted

Those feed the **Discovery Findings & V1 Scope** document. The architecture is locked and ADRs are written only after that.
