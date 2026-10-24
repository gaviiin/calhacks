"""The fictional constructor: Kestrel Grand Prix.

A UK Formula 1 team based at Upper Heyford, Oxfordshire, calendar year end, scaled to roughly
Williams FY2025 (turnover ~GBP 244m, payroll ~GBP 107m, ~1,150 staff). Only the expense side is
modelled. Everything in this file is static reference data; the seeded generator in generate.py
turns it into transactions.

Two legal entities, both in the Reporting Group:
  TECHNOLOGY  Kestrel Technology Ltd, the parent. Employs every member of staff, owns the Upper
              Heyford campus, the driver-in-loop simulator and the engineering IP, and recharges
              RACING monthly for simulator time and engineering services (a Related Party
              Transaction valued at max(contract, fair value), D6.1.1.a / ISS22 4.1(a)).
  RACING      Kestrel Grand Prix Racing Ltd, the F1 Team entity. Holds the FIA entry, buys parts,
              the power unit, freight and travel, runs race operations and partner hospitality.

Intercompany elimination is out of scope: the recharge covers simulator and IP services whose
underlying costs are not part of this ledger, so there is no double count.

`default_category_code` on accounts is the 2026 chart of accounts (finance updated the defaults
from the draft 2026 regulations). `default_2025` is what the same account defaulted to under the
2021-25 regulations (Issue 22); it drives how the busy 2025 ERP user coded lines.
"""

from __future__ import annotations

import hashlib
from datetime import date

COMPANY = {
    "name": "Kestrel Grand Prix",
    "country": "GB",
    "site": "Upper Heyford, Oxfordshire OX25",
    "year_end": "12-31",
    "functional_currency": "GBP",
    "headcount": 1147,
    "title_partner": "Orrery Fintech plc",
}

ENTITIES = {
    "RACING": {
        "legal_name": "Kestrel Grand Prix Racing Ltd",
        "role": "F1 Team entity: FIA entry, race operations, parts, power unit, freight, travel, partner hospitality",
        "parent": "TECHNOLOGY",
    },
    "TECHNOLOGY": {
        "legal_name": "Kestrel Technology Ltd",
        "role": "Parent: employs all staff, owns the campus, simulator and IP, recharges RACING monthly",
        "parent": None,
    },
}

# Materiality used by the 2025 approvals log (and by the 2026 system of work settings).
MATERIALITY_USD_MINOR = 25_000_000  # $250,000
CAP_2026_USD_MINOR = 21_500_000_000  # $215m, D4.1.2
EXCLUDED_BONUS_MAX_USD_MINOR = 1_200_000_000  # $12m (not champion, not improved), D5.1.1.k.ii
PU_SECTION_A_MAX_PRICE_EUR_MINOR = 2_100_000_000  # EUR 21.0m, contract assumption (exact Section A figure uncertain)

# ---------------------------------------------------------------------------------------------
# Chart of accounts: (code, name, default_category_code (2026), default_2025, kind)
# ---------------------------------------------------------------------------------------------
ACCOUNTS: list[tuple[str, str, str, str, str]] = [
    ("5010", "Salaries & wages", "RELEVANT", "RELEVANT", "expense"),
    ("5040", "Employer NI - base (13.8%)", "SOCIAL_SECURITY", "RELEVANT", "expense"),
    ("5041", "Employer NI - excess over 13.8%", "SOCIAL_SECURITY", "SOCIAL_SECURITY", "expense"),
    ("5050", "Employer pension contributions", "RELEVANT", "RELEVANT", "expense"),
    ("5060", "Employee bonuses", "BONUS", "BONUS", "expense"),
    ("5070", "Sick pay", "RELEVANT", "RELEVANT", "expense"),
    ("5080", "Parental leave pay", "PARENTAL_LEAVE", "PARENTAL_LEAVE", "expense"),
    ("5090", "F1 driver retainers", "F1_DRIVER", "F1_DRIVER", "expense"),
    ("5095", "Driver academy programme", "OTHER_DRIVER_ACADEMY", "OTHER_DRIVER_ACADEMY", "expense"),
    ("5100", "Executive remuneration (three highest paid)", "EXCLUDED_PERSONS", "EXCLUDED_PERSONS", "expense"),
    ("5110", "Apprenticeship levy", "RELEVANT", "RELEVANT", "expense"),
    ("5200", "Contract & agency staff", "RELEVANT", "RELEVANT", "expense"),
    ("5210", "Recruitment fees", "HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL", "expense"),
    ("5220", "Training & development", "RELEVANT", "RELEVANT", "expense"),
    ("5230", "Staff expenses & subsistence", "RELEVANT", "RELEVANT", "expense"),
    ("6010", "Composite materials", "RELEVANT", "RELEVANT", "expense"),
    ("6020", "Machined & additive components", "RELEVANT", "RELEVANT", "expense"),
    ("6030", "Electronics & sensors", "RELEVANT", "RELEVANT", "expense"),
    ("6040", "Tooling & workshop consumables", "RELEVANT", "RELEVANT", "expense"),
    ("6050", "Crash damage repairs & race spares", "RELEVANT", "RELEVANT", "expense"),
    ("6060", "Inventory transfers & write-downs", "RELEVANT", "RELEVANT", "expense"),
    ("6100", "Power unit supply", "PU_SUPPLY", "PU_SUPPLY", "expense"),
    ("6105", "PU services outside supply perimeter", "RELEVANT", "RELEVANT", "expense"),
    ("6110", "Fuel & lubricants", "FUEL", "RELEVANT", "expense"),
    ("6120", "Tyres", "RELEVANT", "RELEVANT", "expense"),
    ("6200", "Wind tunnel & CFD", "RELEVANT", "RELEVANT", "expense"),
    ("6210", "Simulator & test rigs", "RELEVANT", "RELEVANT", "expense"),
    ("6300", "Freight & logistics", "RELEVANT", "RELEVANT", "expense"),
    ("6310", "Travel - flights & rail", "COMPETITION_TRAVEL", "COMPETITION_TRAVEL", "expense"),
    ("6320", "Travel - hotels", "COMPETITION_TRAVEL", "COMPETITION_TRAVEL", "expense"),
    ("6330", "Travel - ground transport", "COMPETITION_TRAVEL", "RELEVANT", "expense"),
    ("6400", "Staff entertainment", "STAFF_ENTERTAINMENT", "STAFF_ENTERTAINMENT", "expense"),
    ("6410", "Catering & canteen", "CATERING", "RELEVANT", "expense"),
    ("6420", "Hospitality - guests & partners", "MARKETING", "MARKETING", "expense"),
    ("6500", "Marketing & brand", "MARKETING", "MARKETING", "expense"),
    ("6510", "Partner activation & events", "MARKETING", "MARKETING", "expense"),
    ("6600", "Legal fees", "HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL", "expense"),
    ("6610", "Audit & accountancy", "HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL", "expense"),
    ("6620", "HR & payroll services", "HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL", "expense"),
    ("6700", "Rent & rates", "PROPERTY", "PROPERTY", "expense"),
    ("6710", "Utilities", "RELEVANT", "RELEVANT", "expense"),
    ("6720", "Repairs & maintenance - plant & equipment", "RELEVANT", "RELEVANT", "expense"),
    ("6730", "Repairs & maintenance - buildings", "RELEVANT", "RELEVANT", "expense"),  # never Property Costs (ISS22 or SECD)
    ("6740", "Health & safety", "HEALTH_SAFETY", "HR_FINANCE_LEGAL", "expense"),  # ISS22 HR Activities incl. health and safety matters
    ("6750", "IT, software & licences", "RELEVANT", "RELEVANT", "expense"),
    ("6760", "Insurance", "RELEVANT", "RELEVANT", "expense"),
    ("6800", "Heritage fleet operations", "HERITAGE", "HERITAGE", "expense"),
    ("6810", "Applied Technologies projects", "NON_F1", "NON_F1", "expense"),
    ("6900", "FIA & commercial rights fees", "FIA_FEES", "FIA_FEES", "expense"),
    ("6910", "FIA fines & penalties", "FINES", "FINES", "expense"),
    ("6920", "Sustainability initiatives", "SUSTAINABILITY", "SUSTAINABILITY", "expense"),
    ("6930", "Business continuity & disaster recovery", "BCDR", "RELEVANT", "expense"),
    ("7000", "Depreciation - plant & equipment", "RELEVANT", "DEPRECIATION", "expense"),
    ("7010", "Depreciation - property", "DEPRECIATION", "DEPRECIATION", "expense"),
    ("7100", "Interest & finance charges", "FINANCE_COSTS", "FINANCE_COSTS", "expense"),
    ("7110", "FX gains & losses", "FX", "FX", "expense"),
    ("7200", "Corporation tax", "CORP_TAX", "CORP_TAX", "expense"),
    ("7300", "R&D expenditure credit (RDEC)", "ADJ_GRANT_GROSS_UP", "RELEVANT", "contra_expense"),
    ("7400", "Related-party recharges - Kestrel Technology", "RELEVANT", "RELEVANT", "expense"),
    ("7500", "Gain/loss on disposal of fixed assets", "ADJ_GRANT_GROSS_UP", "DEPRECIATION", "contra_expense"),
]
ACCOUNT = {a[0]: {"code": a[0], "name": a[1], "default": a[2], "default_2025": a[3], "kind": a[4]} for a in ACCOUNTS}

# ---------------------------------------------------------------------------------------------
# Departments: key -> (name, head, f1_activity_share, headcount, avg_salary_gbp, category)
# category is the cap treatment of the department's own payroll (2025 / 2026), see generate.py.
# ---------------------------------------------------------------------------------------------
DEPARTMENTS: dict[str, dict] = {
    "AERO": {"name": "Aerodynamics", "head": "Dr Imogen Hartley", "share": 1.0, "hc": 228, "avg": 84_000},
    "CHASSIS": {"name": "Chassis & Composites Design", "head": "Marcus Feld", "share": 1.0, "hc": 166, "avg": 79_000},
    "VD": {"name": "Vehicle Dynamics", "head": "Priya Raman", "share": 1.0, "hc": 74, "avg": 83_000},
    "RACEOPS": {"name": "Race Operations", "head": "Tomasz Wierzbicki", "share": 1.0, "hc": 92, "avg": 74_000},
    "MFG": {"name": "Manufacturing", "head": "Gareth Pryce", "share": 1.0, "hc": 276, "avg": 47_500},
    "LOGISTICS": {"name": "Logistics", "head": "Sinead Doyle", "share": 1.0, "hc": 40, "avg": 43_000},
    "MARKETING": {"name": "Marketing & Partnerships", "head": "Alicia Moreau", "share": 1.0, "hc": 46, "avg": 54_000},
    "HOSPITALITY": {"name": "Hospitality & Catering", "head": "Ben Okonkwo", "share": 1.0, "hc": 30, "avg": 33_500},
    "HR": {"name": "Human Resources", "head": "Rachel Lim", "share": 1.0, "hc": 18, "avg": 51_000},
    "FINANCE": {"name": "Finance", "head": "David Achterberg", "share": 1.0, "hc": 24, "avg": 58_000},
    "LEGAL": {"name": "Legal", "head": "Hannah Cole", "share": 1.0, "hc": 8, "avg": 98_000},
    "HERITAGE": {"name": "Heritage & Collections", "head": "Colin Ashworth", "share": 1.0, "hc": 12, "avg": 48_000},
    "APPLIED": {"name": "Applied Technologies", "head": "Dr Kenji Mori", "share": 0.6, "hc": 86, "avg": 62_500},
    "FACILITIES": {"name": "Facilities", "head": "Stuart Bell", "share": 1.0, "hc": 44, "avg": 37_000},
    "EXEC": {"name": "Executive Office", "head": "Team Principal", "share": 1.0, "hc": 3, "avg": 0},
    "CORP": {"name": "Corporate (unallocated)", "head": "Finance Director", "share": 1.0, "hc": 0, "avg": 0},
}

# Payroll treatment of each department's own staff: (2025 category, 2026 category).
# "SPLIT" = split by f1_activity_share (RELEVANT share / NON_F1 remainder).
DEPT_PAYROLL_CATEGORY: dict[str, tuple[str, str]] = {
    "AERO": ("RELEVANT", "RELEVANT"),
    "CHASSIS": ("RELEVANT", "RELEVANT"),
    "VD": ("RELEVANT", "RELEVANT"),
    "RACEOPS": ("RELEVANT", "RELEVANT"),
    "MFG": ("RELEVANT", "RELEVANT"),
    "LOGISTICS": ("RELEVANT", "RELEVANT"),
    "FACILITIES": ("RELEVANT", "RELEVANT"),
    "MARKETING": ("MARKETING", "MARKETING"),
    "HOSPITALITY": ("RELEVANT", "CATERING"),  # motorhome & factory catering crew: no catering exclusion before 2026
    "HR": ("HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL"),
    "FINANCE": ("HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL"),
    "LEGAL": ("HR_FINANCE_LEGAL", "HR_FINANCE_LEGAL"),
    "HERITAGE": ("HERITAGE", "HERITAGE"),
    # 2026: D5.1.1.h.c.A apportions Consideration only for PU supply, Customer Team Support, FIA Projects and
    # Standard Supply Components. Generic Applied Technologies client work is none of these: 100% Relevant.
    "APPLIED": ("SPLIT", "RELEVANT"),
}

EXCLUDED_PERSONS = [  # three highest paid individuals (drivers are not counted), monthly GBP
    ("Team Principal", 152_000),
    ("Chief Executive Officer", 118_000),
    ("Technical Director", 131_000),
]

# ---------------------------------------------------------------------------------------------
# Vendors
# ---------------------------------------------------------------------------------------------
# id, name, country, currency, related_party_entity|None, category_hint (2026 code)|None,
# invoice prefix, payment terms (days), address line
_VENDORS = [
    ("ven-001", "Grove Catering Services Ltd", "GB", "GBP", None, "CATERING", "GCS", 30, "Unit 4, Heyford Park, Upper Heyford OX25 5HD"),
    ("ven-002", "Paddock Table Hospitality Ltd", "GB", "GBP", None, None, "PTH", 30, "12 Brook Street, London W1K 4HR"),
    ("ven-003", "Kestrel Technology Ltd", "GB", "GBP", "TECHNOLOGY", None, "KTL", 30, "Camp Road, Upper Heyford OX25 5HD"),
    ("ven-004", "Valcourt Powertrains SAS", "FR", "EUR", None, "PU_SUPPLY", "VPT", 30, "14 avenue des Moteurs, 78280 Guyancourt"),
    ("ven-005", "Meridian Express Logistics Ltd", "GB", "GBP", None, "RELEVANT", "MEX", 30, "Cargo Terminal 2, Heathrow TW6 3RS"),
    ("ven-006", "Bluewater Container Lines BV", "NL", "EUR", None, "RELEVANT", "BCL", 45, "Waalhaven O.z. 81, 3087 BM Rotterdam"),
    ("ven-007", "Northbrook Wind Tunnel Ltd", "GB", "GBP", None, "RELEVANT", "NWT", 30, "Thurleigh Road, Bedford MK44 2YP"),
    ("ven-008", "Northstar HPC Ltd", "GB", "GBP", None, "RELEVANT", "NHP", 30, "Harwell Campus, Didcot OX11 0QX"),
    ("ven-009", "Cotswold Composites Ltd", "GB", "GBP", None, "RELEVANT", "CCL", 30, "Unit 9, Kemble Business Park, Cirencester GL7 6BQ"),
    ("ven-010", "Hexalam Prepreg GmbH", "DE", "EUR", None, "RELEVANT", "HXP", 30, "Industriestrasse 22, 86899 Landsberg am Lech"),
    ("ven-011", "Thames Precision Machining Ltd", "GB", "GBP", None, "RELEVANT", "TPM", 30, "Station Yard, Thame OX9 3UH"),
    ("ven-012", "Additive Forge Ltd", "GB", "GBP", None, "RELEVANT", "AFL", 30, "Unit 3, Bicester Gateway OX26 6BP"),
    ("ven-013", "Apex Motorsport Electronics Ltd", "GB", "GBP", None, "RELEVANT", "AME", 30, "Pury Hill Business Park, Towcester NN12 7LS"),
    ("ven-014", "Delta Telemetry Inc", "US", "USD", None, "RELEVANT", "DTI", 30, "4410 Speedway Blvd, Indianapolis IN 46222"),
    ("ven-015", "Ironbridge Tooling Supplies Ltd", "GB", "GBP", None, "RELEVANT", "ITS", 30, "Wharfage Works, Telford TF8 7DQ"),
    ("ven-016", "Ruota Racing Tyres SpA", "IT", "EUR", None, "RELEVANT", "RRT", 30, "Viale Sarca 222, 20126 Milano"),
    ("ven-017", "Calder Fuels plc", "GB", "GBP", None, "FUEL", "CFP", 30, "Grangemouth Road, Falkirk FK3 8XP"),
    ("ven-018", "Harcourt Lyle LLP", "GB", "GBP", None, "HR_FINANCE_LEGAL", "HLL", 30, "1 Ropemaker Street, London EC2Y 9HT"),
    ("ven-019", "Whitcombe Hale LLP", "GB", "GBP", None, "HR_FINANCE_LEGAL", "WHL", 30, "3 Worcester Street, Oxford OX1 2BX"),
    ("ven-020", "Pitlane Talent Partners Ltd", "GB", "GBP", None, "HR_FINANCE_LEGAL", "PTP", 30, "18 Sheep Street, Bicester OX26 6JF"),
    ("ven-021", "Ashdown People Services Ltd", "GB", "GBP", None, "HR_FINANCE_LEGAL", "APS", 30, "Ashdown House, Reading RG1 1AX"),
    ("ven-022", "Brightwater Creative Ltd", "GB", "GBP", None, "MARKETING", "BWC", 30, "40 Great Sutton Street, London EC1V 0DX"),
    ("ven-023", "Grandstand Events Ltd", "GB", "GBP", None, "MARKETING", "GSE", 30, "Silverstone Park, Towcester NN12 8GX"),
    ("ven-024", "Oxon Plant Services Ltd", "GB", "GBP", None, "RELEVANT", "OPS", 30, "Unit 12, Cherwell Business Village, Banbury OX16 2SP"),
    ("ven-025", "Cherwell Building Maintenance Ltd", "GB", "GBP", None, "RELEVANT", "CBM", 30, "7 Tramway Road, Banbury OX16 5TD"),
    ("ven-026", "Wessex Energy Supply Ltd", "GB", "GBP", None, "RELEVANT", "WES", 14, "Energy House, Swindon SN1 1AB"),
    ("ven-027", "Heyford Park Estates Ltd", "GB", "GBP", None, "PROPERTY", "HPE", 14, "Heyford Park House, Upper Heyford OX25 5HA"),
    ("ven-028", "Trellis Engineering Software Inc", "US", "USD", None, "RELEVANT", "TES", 30, "100 Summer Street, Boston MA 02110"),
    ("ven-029", "Lambourne Specialty Insurance Ltd", "GB", "GBP", None, "RELEVANT", "LSI", 30, "52 Lime Street, London EC3M 7AF"),
    ("ven-030", "Classic Chassis Restorations Ltd", "GB", "GBP", None, "HERITAGE", "CCR", 30, "The Old Forge, Brackley Road, Westbury NN13 5JT"),
    ("ven-031", "Velox Junior Racing Srl", "IT", "EUR", None, "OTHER_DRIVER_ACADEMY", "VJR", 30, "Via dell'Autodromo 5, 40026 Imola"),
    ("ven-032", "Summit Events & Parties Ltd", "GB", "GBP", None, "STAFF_ENTERTAINMENT", "SEP", 30, "2 Market Place, Woodstock OX20 1TA"),
    ("ven-033", "SafeWorks Occupational Health Ltd", "GB", "GBP", None, "HEALTH_SAFETY", "SOH", 30, "Kingsmead Business Park, High Wycombe HP11 1JU"),
    ("ven-034", "Greenlap Carbon Solutions Ltd", "GB", "GBP", None, "SUSTAINABILITY", "GCL", 30, "Edmund Halley Road, Oxford OX4 4GB"),
    ("ven-035", "Resilient Continuity Systems Ltd", "GB", "GBP", None, "BCDR", "RCS", 30, "Thames Valley Park, Reading RG6 1RA"),
    ("ven-036", "Oxford & County Bank plc", "GB", "GBP", None, "FINANCE_COSTS", "OCB", 0, "88 High Street, Oxford OX1 4BJ"),
    ("ven-037", "Paddock Travel Partners Ltd", "GB", "GBP", None, None, "PTV", 30, "Sovereign Court, Milton Keynes MK9 2HR"),
    ("ven-038", "Albion Airways plc", "GB", "GBP", None, None, "ALB", 14, "Compass Centre, Hounslow TW6 2JA"),
    ("ven-039", "Circuit Stay Hotels Ltd", "GB", "GBP", None, None, "CSH", 30, "25 Canada Square, London E14 5LQ"),
    ("ven-040", "Lone Star Hospitality Group LLC", "US", "USD", None, None, "LSH", 30, "301 Congress Ave, Austin TX 78701"),
    ("ven-041", "Velocity Chauffeur & Car Hire Ltd", "GB", "GBP", None, None, "VCH", 30, "Unit 6, Bicester Avenue OX26 3PZ"),
    ("ven-042", "Federation Internationale de l'Automobile", "FR", "EUR", None, "FIA_FEES", "FIA", 30, "8 place de la Concorde, 75008 Paris"),
    ("ven-043", "Formula One Management Ltd", "GB", "USD", None, "FIA_FEES", "FOM", 30, "2 St James's Market, London SW1Y 4AH"),
    ("ven-044", "Hexagon Engineering Contractors Ltd", "GB", "GBP", None, "RELEVANT", "HEC", 30, "Milton Park, Abingdon OX14 4RY"),
    ("ven-045", "Halden Driver Management SAM", "MC", "EUR", None, "F1_DRIVER", "HDM", 15, "7 avenue Princesse Grace, 98000 Monaco"),
    ("ven-046", "Arrowsmith Racing Services Ltd", "GB", "GBP", None, "F1_DRIVER", "ARS", 15, "Old Bank Chambers, Chipping Norton OX7 5AD"),
    ("ven-047", "Orrery Fintech plc", "GB", "GBP", None, "MARKETING", "ORR", 30, "1 Finsbury Avenue, London EC2M 2PF"),
    ("ven-048", "Coldstream Simulation Systems Ltd", "GB", "GBP", None, "RELEVANT", "CSS", 30, "Unit 2, Coldstream Business Centre, Milton Keynes MK12 5TS"),
    ("ven-049", "Monocoque IT Services Ltd", "GB", "GBP", None, "RELEVANT", "MIT", 30, "Oxford Business Park, Oxford OX4 2RU"),
    ("ven-050", "Brightline Training Academy Ltd", "GB", "GBP", None, "RELEVANT", "BTA", 30, "Daventry Road, Banbury OX16 3JT"),
    ("ven-051", "Voltaic Cell Labs Ltd", "GB", "GBP", None, "NON_F1", "VCL", 30, "Begbroke Science Park, Kidlington OX5 1PF"),
]

_IBAN_BANK = {"GB": ["NWBK", "BARC", "LOYD", "HBUK", "MIDL"], "NL": ["ABNA", "INGB", "RABO"]}
_IBAN_LEN = {"GB": 22, "DE": 22, "FR": 27, "IT": 27, "NL": 18, "MC": 27}


def _iban_check(country: str, bban: str) -> str:
    rearranged = bban + country + "00"
    num = "".join(str(int(ch, 36)) for ch in rearranged)
    return f"{98 - int(num) % 97:02d}"


def make_iban(country: str, salt: str) -> str:
    """A syntactically valid IBAN (mod-97 check digits) derived from a salt. US vendors bank in GB."""
    if country not in _IBAN_LEN:
        country = "GB"
    digits = str(int(hashlib.sha256(salt.encode()).hexdigest(), 16))
    if country == "GB":
        bank = _IBAN_BANK["GB"][int(digits[0]) % 5]
        bban = bank + digits[1:15]
    elif country == "NL":
        bank = _IBAN_BANK["NL"][int(digits[0]) % 3]
        bban = bank + digits[1:11]
    elif country == "IT":
        bban = "X" + digits[1:23]
    else:
        bban = digits[1 : _IBAN_LEN[country] - 3]
    return country + _iban_check(country, bban) + bban


VENDORS: dict[str, dict] = {}
for _v in _VENDORS:
    VENDORS[_v[0]] = {
        "id": _v[0],
        "name": _v[1],
        "country": _v[2],
        "currency": _v[3],
        "related_party": _v[4] is not None,
        "related_party_entity": _v[4],
        "category_hint": _v[5],
        "inv_prefix": _v[6],
        "terms": _v[7],
        "address": _v[8],
        "bank_iban": make_iban(_v[2], f"kestrel:{_v[0]}:primary"),
    }

# The canteen operator, the hospitality caterer and the related party, by role.
V_CANTEEN = "ven-001"
V_HOSPITALITY = "ven-002"
V_TECHNOLOGY = "ven-003"
V_PU = "ven-004"

# ---------------------------------------------------------------------------------------------
# Contracts and fair value schedule
# ---------------------------------------------------------------------------------------------
CONTRACTS = [
    {
        "id": "ctr-001", "counterparty_vendor_id": "ven-004", "kind": "PU_SUPPLY", "start": "2025-01-01", "end": "2025-12-31",
        "terms": {"annual_price_minor": 1_700_000_000, "currency": "EUR", "instalments": 12,
                  "perimeter": "Power Unit Supply Perimeter per Section A", "section_a_max_price_minor": PU_SECTION_A_MAX_PRICE_EUR_MINOR,
                  "trackside_support_monthly_minor": 15_000_000, "trackside_support_fair_value_id": "fv-003"},
    },
    {
        "id": "ctr-002", "counterparty_vendor_id": "ven-004", "kind": "PU_SUPPLY", "start": "2026-01-01", "end": "2026-12-31",
        "terms": {"annual_price_minor": 1_920_000_000, "currency": "EUR", "instalments": 12,
                  "perimeter": "Power Unit Supply Perimeter per Section A (2026 power unit)", "section_a_max_price_minor": PU_SECTION_A_MAX_PRICE_EUR_MINOR,
                  "trackside_support_monthly_minor": 15_000_000, "trackside_support_fair_value_id": "fv-003",
                  "additional_elements": "billed at list price; counts toward the Section A maximum"},
    },
    {
        "id": "ctr-003", "counterparty_vendor_id": "ven-003", "kind": "RECHARGE", "start": "2025-01-01", "end": "2026-12-31",
        "terms": {"currency": "GBP", "monthly_fee_minor_2025": 65_000_000, "monthly_fee_minor_2026": 66_500_000,
                  "services": ["driver-in-loop simulator time", "engineering IP licence", "shared engineering services"],
                  "fair_value_ids": ["fv-001", "fv-002"], "valuation": "max(contract, fair value) per D6.1.1.a / ISS22 4.1(a)",
                  "entity_from": "TECHNOLOGY", "entity_to": "RACING"},
    },
    {
        "id": "ctr-004", "counterparty_vendor_id": "ven-005", "kind": "FREIGHT", "start": "2025-01-01", "end": "2026-12-31",
        "terms": {"currency": "GBP", "service": "air and road freight, flyaway kit, customs brokerage",
                  "rate_card": {"flyaway_air_per_kg_minor": 1_950, "european_road_per_round_minor": 5_200_000}},
    },
    {
        "id": "ctr-005", "counterparty_vendor_id": "ven-006", "kind": "FREIGHT", "start": "2025-01-01", "end": "2026-12-31",
        "terms": {"currency": "EUR", "service": "sea freight, four rotating container sets (A-D)", "container_sets": 4},
    },
    {
        "id": "ctr-006", "counterparty_vendor_id": "ven-047", "kind": "SPONSORSHIP", "start": "2025-01-01", "end": "2027-12-31",
        "terms": {"currency": "GBP", "annual_fee_minor": 3_800_000_000, "role": "title partner",
                  "hospitality_obligations": "partner dinners at the factory and Paddock Club passes at 12 rounds; costs are Marketing Activities"},
    },
]

FAIR_VALUES = [
    {"id": "fv-001", "counterparty_vendor_id": "ven-003", "item": "Monthly recharge: simulator time, engineering IP licence and shared engineering services (2025)",
     "contract_value_minor": 65_000_000, "fair_value_minor": 62_000_000, "currency": "GBP", "effective_from": "2025-01-01",
     "basis": "Cost-plus 5% benchmark, Whitcombe Hale transfer pricing study 2024"},
    {"id": "fv-002", "counterparty_vendor_id": "ven-003", "item": "Monthly recharge: simulator time, engineering IP licence and shared engineering services (2026)",
     "contract_value_minor": 66_500_000, "fair_value_minor": 64_000_000, "currency": "GBP", "effective_from": "2026-01-01",
     "basis": "Cost-plus 5% benchmark, Whitcombe Hale transfer pricing study 2025"},
    {"id": "fv-003", "counterparty_vendor_id": "ven-004", "item": "Monthly PU trackside and dyno support services (outside supply perimeter)",
     "contract_value_minor": 15_000_000, "fair_value_minor": 14_000_000, "currency": "EUR", "effective_from": "2025-01-01",
     "basis": "Comparable customer-team support pricing, two quotes"},
    {"id": "fv-004", "counterparty_vendor_id": "ven-004", "item": "Power Unit Supply Perimeter, annual",
     "contract_value_minor": 1_920_000_000, "fair_value_minor": 1_920_000_000, "currency": "EUR", "effective_from": "2026-01-01",
     "basis": "Section A maximum price applies; contract within the maximum"},
]
# Arrives during 2026 (new or updated schedule rows), see generate.py.
FAIR_VALUES_2026_UPDATES = [
    # new row, visible 2026-03-02: a one-off programme priced well below fair value
    ("2026-03-02", {"id": "fv-005", "counterparty_vendor_id": "ven-004", "item": "PU dyno correlation programme (outside supply perimeter), March 2026",
                    "contract_value_minor": 9_000_000, "fair_value_minor": 22_000_000, "currency": "EUR", "effective_from": "2026-03-01",
                    "basis": "Two independent quotes for equivalent dyno programmes"}),
    # updated benchmark, visible 2026-07-01: re-emits fv-002 with a higher fair value
    ("2026-07-01", {"id": "fv-002", "counterparty_vendor_id": "ven-003", "item": "Monthly recharge: simulator time, engineering IP licence and shared engineering services (2026)",
                    "contract_value_minor": 66_500_000, "fair_value_minor": 65_000_000, "currency": "GBP", "effective_from": "2026-01-01",
                    "basis": "Cost-plus 5% benchmark, Whitcombe Hale transfer pricing study 2025, refreshed June 2026"}),
]

# ---------------------------------------------------------------------------------------------
# Season calendars. Dates are approximate (race Sunday, or Saturday for night races); they are
# plausible, not authoritative, and only drive freight, travel, fuel and catering timing.
# ---------------------------------------------------------------------------------------------
# (round, name, city, date, region) region: EU (road freight), FLY (air + sea freight), AM (Americas hotels)
CALENDAR_2025 = [
    (1, "Australian", "Melbourne", "2025-03-16", "FLY"),
    (2, "Chinese", "Shanghai", "2025-03-23", "FLY"),
    (3, "Japanese", "Suzuka", "2025-04-06", "FLY"),
    (4, "Bahrain", "Sakhir", "2025-04-13", "FLY"),
    (5, "Saudi Arabian", "Jeddah", "2025-04-20", "FLY"),
    (6, "Miami", "Miami", "2025-05-04", "AM"),
    (7, "Emilia Romagna", "Imola", "2025-05-18", "EU"),
    (8, "Monaco", "Monte Carlo", "2025-05-25", "EU"),
    (9, "Spanish", "Barcelona", "2025-06-01", "EU"),
    (10, "Canadian", "Montreal", "2025-06-15", "AM"),
    (11, "Austrian", "Spielberg", "2025-06-29", "EU"),
    (12, "British", "Silverstone", "2025-07-06", "EU"),
    (13, "Belgian", "Spa-Francorchamps", "2025-07-27", "EU"),
    (14, "Hungarian", "Budapest", "2025-08-03", "EU"),
    (15, "Dutch", "Zandvoort", "2025-08-31", "EU"),
    (16, "Italian", "Monza", "2025-09-07", "EU"),
    (17, "Azerbaijan", "Baku", "2025-09-21", "FLY"),
    (18, "Singapore", "Singapore", "2025-10-05", "FLY"),
    (19, "United States", "Austin", "2025-10-19", "AM"),
    (20, "Mexico City", "Mexico City", "2025-10-26", "AM"),
    (21, "Sao Paulo", "Sao Paulo", "2025-11-09", "AM"),
    (22, "Las Vegas", "Las Vegas", "2025-11-22", "AM"),
    (23, "Qatar", "Lusail", "2025-11-30", "FLY"),
    (24, "Abu Dhabi", "Yas Marina", "2025-12-07", "FLY"),
]
CALENDAR_2026 = [
    (1, "Australian", "Melbourne", "2026-03-08", "FLY"),
    (2, "Chinese", "Shanghai", "2026-03-15", "FLY"),
    (3, "Japanese", "Suzuka", "2026-03-29", "FLY"),
    (4, "Bahrain", "Sakhir", "2026-04-12", "FLY"),
    (5, "Saudi Arabian", "Jeddah", "2026-04-19", "FLY"),
    (6, "Miami", "Miami", "2026-05-03", "AM"),
    (7, "Canadian", "Montreal", "2026-05-24", "AM"),
    (8, "Monaco", "Monte Carlo", "2026-06-07", "EU"),
    (9, "Barcelona-Catalunya", "Barcelona", "2026-06-14", "EU"),
    (10, "Austrian", "Spielberg", "2026-06-28", "EU"),
    (11, "British", "Silverstone", "2026-07-05", "EU"),
    (12, "Belgian", "Spa-Francorchamps", "2026-07-19", "EU"),
    (13, "Hungarian", "Budapest", "2026-07-26", "EU"),
    (14, "Dutch", "Zandvoort", "2026-08-23", "EU"),
    (15, "Italian", "Monza", "2026-09-06", "EU"),
    (16, "Spanish", "Madrid", "2026-09-13", "EU"),
    (17, "Azerbaijan", "Baku", "2026-09-26", "FLY"),
    (18, "Singapore", "Singapore", "2026-10-11", "FLY"),
    (19, "United States", "Austin", "2026-10-25", "AM"),
    (20, "Mexico City", "Mexico City", "2026-11-01", "AM"),
    (21, "Sao Paulo", "Sao Paulo", "2026-11-08", "AM"),
    (22, "Las Vegas", "Las Vegas", "2026-11-21", "AM"),
    (23, "Qatar", "Lusail", "2026-11-29", "FLY"),
    (24, "Abu Dhabi", "Yas Marina", "2026-12-06", "FLY"),
]
# Pre-season testing (Testing of Current Cars), approximate.
TESTS_2025 = [("Bahrain pre-season test", "Sakhir", "2025-02-26", "FLY")]
TESTS_2026 = [("Barcelona pre-season test", "Barcelona", "2026-01-28", "EU"),
              ("Bahrain pre-season test 1", "Sakhir", "2026-02-12", "FLY"),
              ("Bahrain pre-season test 2", "Sakhir", "2026-02-19", "FLY")]

# Mandatory two-week summer shutdown (factory closed; finance, marketing and legal may continue).
SHUTDOWN = {2025: ("2025-08-04", "2025-08-17"), 2026: ("2026-08-03", "2026-08-16")}
# Christmas factory closure.
XMAS_CLOSURE = {2025: ("2025-12-22", "2025-12-31"), 2026: ("2026-12-21", "2026-12-31")}

UK_BANK_HOLIDAYS = {
    "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-05", "2025-05-26", "2025-08-25", "2025-12-25", "2025-12-26",
    "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
}

# Factory activity multiplier by month: February build spike, August shutdown.
BUILD_FACTOR = {
    2025: [1.5, 2.2, 1.3, 1.0, 1.0, 0.95, 0.9, 0.35, 0.9, 0.95, 1.0, 0.8],
    2026: [1.7, 2.5, 1.4, 1.0, 1.0, 0.95, 0.9, 0.3, 0.9, 0.95, 1.0, 0.8],
}

# Monthly FX to USD (approximate, illustrative).
FX_TO_USD = {
    "GBP": {
        "2025-01": 1.2350, "2025-02": 1.2520, "2025-03": 1.2900, "2025-04": 1.3150, "2025-05": 1.3350, "2025-06": 1.3600,
        "2025-07": 1.3550, "2025-08": 1.3450, "2025-09": 1.3500, "2025-10": 1.3350, "2025-11": 1.3150, "2025-12": 1.3350,
        "2026-01": 1.3450, "2026-02": 1.3520, "2026-03": 1.3400, "2026-04": 1.3380, "2026-05": 1.3460, "2026-06": 1.3550,
        "2026-07": 1.3600, "2026-08": 1.3510, "2026-09": 1.3440, "2026-10": 1.3390, "2026-11": 1.3330, "2026-12": 1.3360,
    },
    "EUR": {
        "2025-01": 1.0350, "2025-02": 1.0400, "2025-03": 1.0800, "2025-04": 1.1250, "2025-05": 1.1280, "2025-06": 1.1500,
        "2025-07": 1.1680, "2025-08": 1.1650, "2025-09": 1.1720, "2025-10": 1.1600, "2025-11": 1.1550, "2025-12": 1.1700,
        "2026-01": 1.1720, "2026-02": 1.1780, "2026-03": 1.1650, "2026-04": 1.1600, "2026-05": 1.1680, "2026-06": 1.1750,
        "2026-07": 1.1800, "2026-08": 1.1710, "2026-09": 1.1660, "2026-10": 1.1620, "2026-11": 1.1580, "2026-12": 1.1600,
    },
}


def fx_rate(currency: str, period_key: str) -> float:
    if currency == "USD":
        return 1.0
    return FX_TO_USD[currency][period_key]


def d(s: str) -> date:
    return date.fromisoformat(s)


def is_business_day(day: date) -> bool:
    return day.weekday() < 5 and day.isoformat() not in UK_BANK_HOLIDAYS


def in_window(day: date, window: tuple[str, str]) -> bool:
    return window[0] <= day.isoformat() <= window[1]


def factory_closed(day: date) -> bool:
    y = day.year
    return in_window(day, SHUTDOWN[y]) or in_window(day, XMAS_CLOSURE[y])
