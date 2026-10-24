"""Planted 2026 errors and the answer key (SCHEMA.md section 5).

Each plant is a specific record in the 2026 stream that a competent cost cap analyst must catch.
The 13 Red Bull 2021 misstatements (Accepted Breach Agreement, 26 Oct 2022; research memo
section 1) are re-staged first, then the accounts-payable classics, the time traps and the
2025-habit traps (lines where the 2025 precedent is the wrong answer in 2026).

answer_key.csv columns: plant_id, source, record_id, error_class, expected_action,
expected_category_code, note. A plant can have several rows (one per affected record).
expected_category_code is the correct 2026 treatment; it is empty where the answer is a split
across bill lines (rows for each bill line follow) or genuinely depends on the answer to the
question the analyst should ask.
"""

from __future__ import annotations

from datetime import date, timedelta

from . import company as C
from . import generate as G

EXPECTED_ACTIONS = ("reclassify", "ask", "hold", "deny", "flag")

ERROR_CLASSES = (
    # Red Bull 2021 ABA, re-staged (item numbers from the research memo)
    "catering_as_marketing",  # 1
    "sick_pay_not_indefinite",  # 2
    "non_f1_double_offset",  # 3
    "bonus_above_exclusion_limit",  # 4
    "disposal_gain_not_grossed_up",  # 5
    "apprenticeship_levy_as_social_security",  # 6
    "mixed_staff_share_unproven",  # 7, 8
    "pu_below_fair_value",  # 9
    "heritage_parts",  # 10
    "related_party_recharge_clerical_error",  # 11
    "non_competition_travel",  # 12
    "maintenance_in_hr",  # 13
    # accounts payable classics
    "duplicate_invoice",
    "split_under_threshold",
    "bank_details_changed",
    # time traps
    "backdated_locked_period",
    "prior_year_catering_in_jan",
    "late_correction_changes_category",
    # other misclassifications
    "tax_credit_not_grossed_up",
    "fx_in_relevant",
    "staff_entertainment_not_all_staff",
    "crash_damage_as_bcdr",
    "depreciation_property_misclass",
    "freight_as_competition_travel",
    "pu_above_max_price",
    "excluded_person_in_relevant",
    # 2025 habit applied to a 2026 rule change
    "sporting_fine_prior_year_habit",
    "ground_transport_prior_year_habit",
    "pe_depreciation_prior_year_habit",
    "bonus_not_formal_scheme",
    "non_f1_apportionment_not_permitted",
    # mixed invoices that must be split by bill line
    "mixed_hospitality_invoice",
    "offsite_lunch_in_canteen_invoice",
)

DEMO_PLANT = "P01"


def _usd(amount_minor: int, ccy: str, day: date) -> int:
    from .generate import to_usd

    return to_usd(amount_minor, C.fx_rate(ccy, day.strftime("%Y-%m")))


def _find(st, tag: str, startswith: str = "", month: int | None = None):
    for ln in st.lines:
        if ln.tag == tag and ln.memo.startswith(startswith) and (month is None or ln.posted.month == month) and ln.plant is None:
            return ln
    raise LookupError(f"no base line tag={tag} memo^={startswith!r} month={month}")


def plant_all(st) -> None:  # noqa: C901 - a flat list of plants reads best
    A = st.answer
    add = st.add

    def line(**kw):
        kw.setdefault("entity", "RACING")
        kw.setdefault("c25", kw.get("c26", "RELEVANT"))
        kw.setdefault("tag", "plant")
        return add(**kw)

    # ---- P01: the demo hospitality invoice (PLAN.md demo beat 1) --------------------------------
    demo_lines = [
        ("Factory canteen - new-car build shift meals, 2-4 Jan 2026 (build team, 3 days)", 1_438_000),
        ("Sponsor dinner - Orrery Fintech partners season preview, factory atrium, 2 Jan 2026", 985_000),
        ("Engineering offsite lunch - aero team at Northbrook Wind Tunnel session, 2 Jan 2026", 720_000),
    ]
    p01 = line(posted=date(2026, 1, 2), acct="6420", dept="MARKETING", vendor=C.V_CANTEEN, amount=sum(a for _, a in demo_lines), ccy="GBP",
               memo="Hospitality - Orrery season preview & build week catering (requester: Marketing)", c26="MARKETING", erp="MARKETING",
               plant="P01", prio=0, visible=date(2026, 1, 2), bill_lines=demo_lines, bill_date=date(2026, 1, 2),
               bill_cats=[G.T_CANTEEN, G.T_MARKETING, G.T_TUNNEL])
    A("P01", p01, "catering_as_marketing", "reclassify", "",
      "Demo invoice. Requester coded the whole Grove Catering bill MARKETING. Split by bill line: canteen CATERING, sponsor dinner MARKETING, wind tunnel lunch RELEVANT (GBP 7,200.00 into the cap).")
    for k, cat, why in [(1, "CATERING", "factory canteen at team premises (D5.1.1.z)"), (2, "MARKETING", "partner dinner (D5.1.1.a)"),
                        (3, "RELEVANT", "offsite engineering lunch at Northbrook Wind Tunnel: not at team premises or a Competition")]:
        A("P01", (p01, k), "catering_as_marketing", "reclassify", cat, f"P01 bill line {k}: {why}", source="bill_line")

    # ---- Red Bull 1: catering treated as marketing ------------------------------------------------
    p = line(posted=date(2026, 3, 11), acct="6420", dept="MARKETING", vendor=C.V_HOSPITALITY, amount=3_862_000, ccy="GBP",
             memo="Motorhome catering - race team & guests - Australian Grand Prix", c26="CATERING", erp="MARKETING", plant="P02")
    A("P02", p, "catering_as_marketing", "reclassify", "CATERING", "Motorhome catering at a Competition coded to the hospitality account as Marketing.")
    p = line(posted=date(2026, 2, 20), acct="6420", dept="MARKETING", vendor=C.V_CANTEEN, amount=648_000, ccy="GBP",
             memo="Factory canteen - extended service hours, build week w/c 2026-02-16 (requested by Marketing for partner visit)",
             c26="CATERING", erp="MARKETING", plant="P03")
    A("P03", p, "catering_as_marketing", "reclassify", "CATERING", "Canteen opening hours for the build team; the partner visit does not make staff catering Marketing.")

    # ---- Red Bull 2: sick pay for an employee not on indefinite leave --------------------------------
    p = line(posted=date(2026, 3, 26), acct="5070", dept="CHASSIS", vendor=None, amount=745_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Sick pay - employee E-10442 (Chassis), 6 weeks post-surgery, return to work 2026-04-20", c26="RELEVANT", erp="INDEFINITE_SICK", plant="P04")
    A("P04", p, "sick_pay_not_indefinite", "reclassify", "RELEVANT", "Employee is returning to work: not indefinite sick leave (D5.1.1.w).")
    p = line(posted=date(2026, 5, 26), acct="5070", dept="MFG", vendor=None, amount=598_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Long-term sick pay - employee E-11873 (Manufacturing), absent since 2025-11, HR case LT-26-03 open", c26="RELEVANT",
             erp="INDEFINITE_SICK", plant="P05")
    A("P05", p, "sick_pay_not_indefinite", "ask", "RELEVANT",
      "Excluded only if formally placed on indefinite leave and not expected to return; no HR letter. Ask HR; Relevant until evidenced.")

    # ---- Red Bull 3: double offset of Non-F1 costs --------------------------------------------------
    q1 = sum(ln.amount for ln in st.lines if ln.tag == "payroll_salaries" and ln.dept == "APPLIED" and ln.posted.month <= 3)
    x = int(q1 * 0.4)
    p = line(posted=date(2026, 3, 31), acct="6810", dept="APPLIED", vendor=None, amount=x, ccy="GBP", entity="TECHNOLOGY",
             memo="Q1 2026 Non-F1 allocation - 40% of Applied Technologies salaries - reclass from 5010 (journal JNL-26-0331)",
             c26="RELEVANT", erp="NON_F1", plant="P06")
    line(posted=date(2026, 3, 31), acct="5010", dept="APPLIED", vendor=None, amount=-x, ccy="GBP", entity="TECHNOLOGY",
         memo="Q1 2026 Non-F1 allocation - contra to 6810 (journal JNL-26-0331)", c26="RELEVANT", erp="RELEVANT", tag="plant_contra")
    A("P06", p, "non_f1_double_offset", "reclassify", "RELEVANT",
      "Reclass journal moving 40% of Applied Technologies salaries to Non-F1. In 2026 no apportionment is permitted for generic Applied Technologies client work "
      "(D5.1.1.h.c.A allows it only for PU supply, Customer Team Support, FIA Projects and Standard Supply Components), so the journal and its 5010 contra are both Relevant and net to nil.")

    # ---- 2026 bonus definition: points, podium, performance and retention bonuses are Relevant ---------------
    for ln in st.lines:
        if ln.tag == "bonus" and ln.plant is None:
            ln.plant = "P42"
            A("P42", ln, "bonus_not_formal_scheme", "reclassify", "RELEVANT",
              "Not Employee Bonus Costs in 2026: only a Formal Bonus Scheme determined solely by the final Constructors' classification and paid in full "
              "after the last Competition qualifies (D1). Points, podium, race-win, annual performance and retention bonuses are Relevant; "
              "the 2025 precedent (ISS22 allowed points, podiums and wins) is wrong for 2026.")

    # ---- Red Bull 4: bonus above the exclusion limit ------------------------------------------------
    # A retention bonus sized (on the 2025 reading of the rules) to take the bonus exclusion $750k over the limit.
    # Under the 2026 definition it is not Employee Bonus Costs at all, so it is wholly Relevant (P42).
    day = date(2026, 3, 26)
    base_bonus_usd = sum(_usd(ln.amount, ln.ccy, ln.posted) for ln in st.lines if ln.tag == "bonus")
    fx = C.fx_rate("GBP", day.strftime("%Y-%m"))
    target_excess_usd = 75_000_000  # $750k over the Excluded Bonus Maximum
    amt = int(round((C.EXCLUDED_BONUS_MAX_USD_MINOR - base_bonus_usd + target_excess_usd) / fx / 100_000)) * 100_000
    p = line(posted=day, acct="5060", dept="CORP", vendor=None, amount=amt, ccy="GBP", entity="TECHNOLOGY",
             memo="Retention bonus - 2026 regulation-change programme, tranche 1 (all engineering staff)", c26="RELEVANT", erp="BONUS", plant="P42")
    A("P42", p, "bonus_not_formal_scheme", "reclassify", "RELEVANT",
      "A retention bonus is not Employee Bonus Costs in 2026 (D1: only a Formal Bonus Scheme determined solely by the final Constructors' "
      "classification and paid after the last Competition). Wholly Relevant.")
    # The one genuine 2026 scheme: a constructors'-classification pool, accrued Jan-Nov at the end of the stream.
    # prio 0 and no vendor: it draws nothing from the stream's random streams, so earlier ids are unchanged.
    day = date(2026, 11, 30)
    fx = C.fx_rate("GBP", day.strftime("%Y-%m"))
    amt = int(round((C.EXCLUDED_BONUS_MAX_USD_MINOR + target_excess_usd) / fx / 100_000)) * 100_000
    amt_usd = _usd(amt, "GBP", day)
    excess_usd = max(0, amt_usd - C.EXCLUDED_BONUS_MAX_USD_MINOR)
    excess_gbp = int(amt * excess_usd / amt_usd)
    p = line(posted=day, acct="5060", dept="CORP", vendor=None, amount=amt, ccy="GBP", entity="TECHNOLOGY", prio=0,
             memo="Bonus accrual Jan-Nov 2026 - BS-26 Constructors' Championship scheme (board resolution 2026-02-20; set solely by the final "
                  "Constructors' classification, payable in full after the last Competition)", c26="BONUS", erp="BONUS", plant="P07", limit_cat="BONUS",
             truth=[("BONUS", amt - excess_gbp, 0, "within the $12m Excluded Bonus Maximum"),
                    ("RELEVANT", excess_gbp, excess_usd, "excess over the $12m Excluded Bonus Maximum (D5.1.1.k)")])
    A("P07", p, "bonus_above_exclusion_limit", "flag", "RELEVANT",
      f"The BS-26 Constructors' Championship scheme is genuine Employee Bonus Costs, but the accrual exceeds the $12m Excluded Bonus Maximum "
      f"(lower than 20% of Total Fixed Employee Remuneration) by ${excess_usd / 100:,.0f}; that excess is Relevant (split: cap_limit_excess).")

    # ---- Red Bull 5: gain on disposal not grossed up -----------------------------------------------
    p = line(posted=date(2026, 4, 30), acct="7500", dept="MFG", vendor=None, amount=-9_600_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Gain on disposal - surplus 5-axis CNC mill sold at auction", c26="ADJ_GRANT_GROSS_UP", erp="DEPRECIATION", plant="P08")
    A("P08", p, "disposal_gain_not_grossed_up", "reclassify", "ADJ_GRANT_GROSS_UP",
      "D6.1.1.b.i.A.2: a gain on disposal netted in costs must be grossed up. The 2025 habit (excluded with depreciation under ISS22 3.1(o)) is wrong for 2026.")

    # ---- Red Bull 6: apprenticeship levy as social security ------------------------------------------
    p = _find(st, "apprenticeship_levy", month=3)
    p.erp, p.plant = "SOCIAL_SECURITY", "P09"
    A("P09", p, "apprenticeship_levy_as_social_security", "reclassify", "RELEVANT", "The Apprenticeship Levy is a payroll tax, not employer's social security.")

    # ---- Red Bull 7/8: unproven Non-F1 share for mixed staff -----------------------------------------
    p = line(posted=date(2026, 4, 30), acct="5050", dept="APPLIED", vendor=None, amount=3_780_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Employer pension true-up - Applied Technologies - Apr 2026 - 70% Non-F1 per project manager estimate (no timesheets)",
             c26="RELEVANT", erp="NON_F1", plant="P10")
    A("P10", p, "mixed_staff_share_unproven", "ask", "RELEVANT",
      "No apportionment for generic Applied Technologies client work in 2026 (D5.1.1.h.c.A: only PU supply, Customer Team Support, FIA Projects "
      "or Standard Supply Components). The 70% estimate is irrelevant unless the staff do one of those; ask, Relevant until then.")
    p = line(posted=date(2026, 6, 26), acct="5010", dept="AERO", vendor=None, amount=8_640_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Salaries - 6 aerodynamicists seconded to Applied Technologies client programme AT-131 - Jun 2026 - 50% Non-F1 claimed, no timesheets",
             c26="RELEVANT", erp="NON_F1", plant="P11")
    A("P11", p, "mixed_staff_share_unproven", "ask", "RELEVANT",
      "Aero staff with an unevidenced 50% Non-F1 claim. Client programme AT-131 is not one of the D5.1.1.h.c.A activities, so even with timesheets "
      "no salary share is excludable; ask what the secondment is, Relevant until then.")

    # ---- Red Bull 9: PU transaction below fair value -------------------------------------------------
    p = line(posted=date(2026, 3, 24), acct="6105", dept="RACEOPS", vendor=C.V_PU, amount=9_000_000, ccy="EUR",
             memo="PU dyno correlation programme - March 2026 (outside supply perimeter)", c26="ADJ_RELATED_PARTY_FAIR_VALUE", erp="RELEVANT",
             plant="P12", fv=("fv-005", 22_000_000))
    A("P12", p, "pu_below_fair_value", "reclassify", "ADJ_RELATED_PARTY_FAIR_VALUE",
      "Power Unit Transaction priced at EUR 90,000 against fair value EUR 220,000 (fv-005, visible 2026-03-02): include at fair value (D6.1.1.a).")

    # ---- Red Bull 10: used parts moved to heritage ----------------------------------------------------
    d13 = date(2026, 4, 16)
    p = line(posted=d13, acct="6800", dept="HERITAGE", vendor=None, amount=18_500_000, ccy="GBP",
             memo="Transfer to heritage collection - 2026 race chassis KGP-26-02 front wing & floor assemblies (raced Australian GP to Japanese GP)",
             c26="ADJ_USED_INVENTORY", erp="HERITAGE", plant="P13",
             truth=[("ADJ_USED_INVENTORY", 18_500_000, _usd(18_500_000, "GBP", d13), "used inventory consumed in 2026 F1 Activities stays in Relevant Costs")])
    A("P13", p, "heritage_parts", "reclassify", "ADJ_USED_INVENTORY", "Parts raced in 2026 are Used Inventory; moving them to heritage does not take their cost out of the cap.")
    d14 = date(2026, 9, 18)
    p = line(posted=d14, acct="6800", dept="HERITAGE", vendor=None, amount=6_400_000, ccy="GBP",
             memo="Transfer to heritage collection - 2025-spec gearbox internals from stores (usage history not attached)",
             c26="ADJ_USED_INVENTORY", erp="HERITAGE", plant="P14",
             truth=[("ADJ_USED_INVENTORY", 6_400_000, _usd(6_400_000, "GBP", d14), "treated as used inventory until usage history shows otherwise")])
    A("P14", p, "heritage_parts", "ask", "", "Ask for the TD017 usage history: used in 2026 F1 Activities -> Used Inventory (Relevant); never used -> heritage may apply.")

    # ---- Red Bull 11: clerical error on related-party recharges ---------------------------------------
    p = _find(st, "recharge", month=6)
    p.amount, p.erp, p.plant, p.c26 = 6_650_000, "RELEVANT", "P15", "ADJ_RELATED_PARTY_FAIR_VALUE"
    p.fv = ("fv-002", 65_000_000)
    A("P15", p, "related_party_recharge_clerical_error", "reclassify", "ADJ_RELATED_PARTY_FAIR_VALUE",
      "Kestrel Technology recharge invoiced GBP 66,500.00 instead of GBP 665,000.00: below fair value (fv-002, GBP 650,000 after the 2026-07-01 update); include at fair value.")

    # ---- Red Bull 12: travel not related to Competitions ----------------------------------------------
    p = line(posted=date(2026, 4, 22), acct="6310", dept="VD", vendor="ven-037", amount=284_000, ccy="GBP",
             memo="Flights - Turin - supplier audit Ruota Racing Tyres", c26="RELEVANT", erp="COMPETITION_TRAVEL", plant="P16")
    A("P16", p, "non_competition_travel", "reclassify", "RELEVANT", "Supplier audit, no Competition or Testing: travel is Relevant.")
    p = line(posted=date(2026, 3, 6), acct="6320", dept="AERO", vendor="ven-039", amount=218_000, ccy="GBP",
             memo="Hotel - Bedford - Northbrook Wind Tunnel session week 10, 6 rooms x 3 nights", c26="RELEVANT", erp="COMPETITION_TRAVEL", plant="P17")
    A("P17", p, "non_competition_travel", "reclassify", "RELEVANT", "Wind tunnel session travel is not Competition travel.")
    p = line(posted=date(2026, 3, 4), acct="6310", dept="RACEOPS", vendor="ven-037", amount=936_000, ccy="GBP",
             memo="Flights - Barcelona - race team (24 pax)", c26="RELEVANT", erp="COMPETITION_TRAVEL", plant="P18")
    A("P18", p, "non_competition_travel", "ask", "",
      "No Competition or Testing of Current Cars in Barcelona in March 2026 (shakedown 26-30 Jan, Grand Prix 14 Jun). Filming day (Marketing) or previous-car running (Relevant)? Ask.")

    # ---- Red Bull 13: maintenance misallocated to HR/Finance/Legal ------------------------------------
    p = line(posted=date(2026, 2, 11), acct="6620", dept="HR", vendor="ven-024", amount=1_465_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Autoclave 1 pressure vessel inspection & seal replacement", c26="RELEVANT", erp="HR_FINANCE_LEGAL", plant="P19")
    A("P19", p, "maintenance_in_hr", "reclassify", "RELEVANT", "Plant maintenance booked to the HR services account by an HR-raised PO.")
    p = line(posted=date(2026, 7, 9), acct="6600", dept="LEGAL", vendor="ven-024", amount=2_730_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Seven-post rig hydraulic actuator overhaul (PO raised by Legal & Compliance)", c26="RELEVANT", erp="HR_FINANCE_LEGAL", plant="P20")
    A("P20", p, "maintenance_in_hr", "reclassify", "RELEVANT", "Test rig maintenance booked to legal fees.")

    # ---- AP classics -------------------------------------------------------------------------------
    orig = line(posted=date(2026, 3, 10), acct="6010", dept="CHASSIS", vendor="ven-009", amount=3_642_000, ccy="GBP",
                memo="PO-26-48211 - monocoque honeycomb core", c26="RELEVANT", tag="materials", inv_no="CCL-26-0311")
    p = line(posted=date(2026, 3, 24), acct="6010", dept="CHASSIS", vendor="ven-009", amount=3_642_000, ccy="GBP",
             memo="PO-26-48211 - monocoque honeycomb core", c26="RELEVANT", erp="RELEVANT", plant="P21", inv_no="CCL-26-0311", hold_payment=True,
             truth=[("RELEVANT", 3_642_000, 0, "duplicate of an invoice already posted; must be reversed, not counted twice")])
    A("P21", p, "duplicate_invoice", "hold", "RELEVANT", "Same vendor, invoice number CCL-26-0311 and amount as {0}.", note_refs=[orig])
    base = _find(st, "gp_travel", "Flights - Miami Grand Prix - race team")
    base.inv_no = "ALB-26-0418"
    p = line(posted=base.posted + timedelta(days=9), acct=base.acct, dept=base.dept, vendor=base.vendor, amount=base.amount, ccy=base.ccy,
             memo=base.memo, c26="COMPETITION_TRAVEL", erp="COMPETITION_TRAVEL", plant="P22", inv_no="ALB-26-0418R", hold_payment=True,
             truth=[("COMPETITION_TRAVEL", base.amount, 0, "re-issued copy of an invoice already posted")])
    A("P22", p, "duplicate_invoice", "hold", "COMPETITION_TRAVEL", "Re-issued invoice ALB-26-0418R: same amount and description as {0} (ALB-26-0418).", note_refs=[base])
    for k in (1, 2, 3):
        p = line(posted=date(2026, 5, 12), acct="6020", dept="MFG", vendor="ven-011", amount=18_500_000, ccy="GBP",
                 memo=f"Gearbox casing machining - batch {k} of 3 (PO-26-51877)", c26="RELEVANT", erp="RELEVANT", plant="P23")
        A("P23", p, "split_under_threshold", "flag", "RELEVANT",
          "One order split into three same-day invoices of GBP 185,000 (~$249k each), just under the $250k materiality threshold.")
    p = line(posted=date(2026, 6, 3), acct="6040", dept="MFG", vendor="ven-015", amount=4_875_000, ccy="GBP",
             memo="PO-26-55102 - cutting tools and inserts (bulk restock)", c26="RELEVANT", erp="RELEVANT", plant="P24", hold_payment=True,
             bill_iban=C.make_iban("GB", "kestrel:ven-015:changed"),
             bill_note="NOTICE: our bank details have changed with immediate effect. Please update your records and remit to the account below.")
    A("P24", p, "bank_details_changed", "hold", "RELEVANT", "IBAN on the bill differs from the vendor master; hold until verified by call-back.", source="gl_line")
    A("P24", (p, None), "bank_details_changed", "hold", "RELEVANT", "Bill carrying the changed bank details.", source="bill")
    p = line(posted=date(2026, 9, 28), acct="6300", dept="LOGISTICS", vendor="ven-005", amount=21_240_000, ccy="GBP",
             memo="Air freight - charter surcharge - Singapore Grand Prix (fuel & security)", c26="RELEVANT", erp="RELEVANT", plant="P36",
             hold_payment=True, bill_iban=C.make_iban("NL", "kestrel:ven-005:changed"),
             bill_note="Our banking partner has changed. New remittance details below - please update and confirm by return.")
    A("P36", p, "bank_details_changed", "hold", "RELEVANT", "Material freight bill with a new (Dutch) IBAN for a UK vendor; hold and verify.", source="gl_line")
    A("P36", (p, None), "bank_details_changed", "hold", "RELEVANT", "Bill carrying the changed bank details.", source="bill")

    # ---- time traps -----------------------------------------------------------------------------
    p = line(posted=date(2026, 1, 27), acct="6020", dept="MFG", vendor="ven-011", amount=4_230_000, ccy="GBP",
             memo="PO-26-40118 - upright machining (invoice received late)", c26="RELEVANT", erp="RELEVANT", plant="P25", visible=date(2026, 4, 21))
    A("P25", p, "backdated_locked_period", "deny", "RELEVANT",
      "Dated into 2026-01 but first visible 2026-04-21; assumes January is locked by then. Never post into the locked period; book in the open period or ask.")
    p = line(posted=date(2026, 2, 26), acct="6020", dept="AERO", vendor="ven-012", amount=1_874_000, ccy="GBP",
             memo="PO-26-43390 - printed cooling ducts (invoice received late)", c26="RELEVANT", erp="RELEVANT", plant="P37", visible=date(2026, 6, 2))
    A("P37", p, "backdated_locked_period", "deny", "RELEVANT",
      "Dated into 2026-02 but first visible 2026-06-02; assumes February is locked by then. Never post into the locked period.")
    p = line(posted=date(2026, 1, 8), acct="6410", dept="FACILITIES", vendor=C.V_CANTEEN, amount=1_692_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Factory canteen service - staff meals w/c 2025-12-15 (invoice received late)", c26="RELEVANT", erp="CATERING", plant="P26",
             bill_date=date(2025, 12, 19),
             truth=[("RELEVANT@ISS22", 1_692_000, 0, "FY2025 cost: ISS22 applies (catering Relevant); belongs to the FY2025 submission, not the 2026 cap")])
    A("P26", p, "prior_year_catering_in_jan", "flag", "RELEVANT",
      "December 2025 canteen invoice booked in 2026-01. It is a 2025 cost under ISS22 (Relevant, no catering exclusion); 2025-12 is locked, so flag it for the FY2025 submission rather than applying the 2026 catering exclusion.")
    p = line(posted=date(2026, 6, 10), acct="6410", dept="HOSPITALITY", vendor=C.V_HOSPITALITY, amount=2_160_000, ccy="GBP",
             memo="Motorhome catering - extended crew service - Monaco Grand Prix (recoded from 6420)", c26="CATERING", erp="CATERING", plant="P35",
             visible=date(2026, 6, 10),
             emissions=[(date(2026, 6, 10), {"acct": "6420", "dept": "MARKETING", "erp": "MARKETING", "memo": "Hospitality - Monaco Grand Prix - additional service"}),
                        (date(2026, 7, 8), {})])
    A("P35", p, "late_correction_changes_category", "reclassify", "CATERING",
      "Re-emitted 2026-07-08 with account 6420 -> 6410 and a catering memo. Reopen the item: the MARKETING classification made on the first version no longer stands.")

    # ---- other misclassifications ----------------------------------------------------------------
    p = line(posted=date(2026, 4, 30), acct="7300", dept="CORP", vendor=None, amount=-138_000_000, ccy="GBP", entity="TECHNOLOGY",
             memo="RDEC above-the-line credit - Q1 2026 qualifying R&D expenditure", c26="ADJ_GRANT_GROSS_UP", erp="RELEVANT", plant="P27")
    A("P27", p, "tax_credit_not_grossed_up", "reclassify", "ADJ_GRANT_GROSS_UP",
      "D6.1.1.b.i.A.1: R&D incentive income offset against costs must be grossed up. The 2025 precedent (offset reduces Relevant Costs, ISS22 4.1(b)(ii)) flipped.")
    p = line(posted=date(2026, 5, 29), acct="6010", dept="CORP", vendor=None, amount=3_820_000, ccy="GBP",
             memo="FX revaluation - EUR prepreg payables (Hexalam Prepreg) - May 2026", c26="FX", erp="RELEVANT", plant="P28")
    A("P28", p, "fx_in_relevant", "reclassify", "FX", "FX revaluation posted to the materials account.")
    p = line(posted=date(2026, 6, 10), acct="6400", dept="RACEOPS", vendor="ven-032", amount=945_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Race team celebration dinner - Monaco Grand Prix podium (42 staff)", c26="RELEVANT", erp="STAFF_ENTERTAINMENT", plant="P29")
    A("P29", p, "staff_entertainment_not_all_staff", "reclassify", "RELEVANT", "Entertainment for one team, not all employees on an equal basis (D5.1.1.u).")
    p = line(posted=date(2026, 11, 17), acct="6050", dept="RACEOPS", vendor="ven-009", amount=115_000_000, ccy="GBP",
             memo="Sao Paulo GP crash - emergency monocoque rebuild & recovery programme", c26="RELEVANT", erp="BCDR", plant="P30")
    A("P30", p, "crash_damage_as_bcdr", "reclassify", "RELEVANT", "Crash damage is inside the cap; business continuity (D5.1.1.aa) is not a crash budget.")
    p = line(posted=date(2026, 2, 27), acct="7010", dept="AERO", vendor=None, amount=4_600_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Depreciation - wind tunnel model-making CNC & clean room equipment - Feb 2026", c26="RELEVANT", erp="DEPRECIATION", plant="P31")
    A("P31", p, "depreciation_property_misclass", "reclassify", "RELEVANT",
      "Plant and equipment depreciated through the property account; P&E depreciation is inside the cap (D6.1.1.k).")
    p = _find(st, "freight", "Air freight - Japanese Grand Prix")
    p.erp, p.plant = "COMPETITION_TRAVEL", "P32"
    A("P32", p, "freight_as_competition_travel", "reclassify", "RELEVANT", "Air freight is inside the cap; D5.1.1.r covers personnel travel only.")
    p = next(ln for ln in st.lines if ln.tag == "freight" and ln.memo.startswith("Sea freight") and "Singapore" in ln.memo)
    p.erp, p.plant = "COMPETITION_TRAVEL", "P33"
    A("P33", p, "freight_as_competition_travel", "reclassify", "RELEVANT", "Sea freight is inside the cap.")
    d34 = date(2026, 10, 6)
    annual = 1_920_000_000 + 260_000_000
    excess = max(0, annual - C.PU_SECTION_A_MAX_PRICE_EUR_MINOR)
    p = line(posted=d34, acct="6100", dept="RACEOPS", vendor=C.V_PU, amount=260_000_000, ccy="EUR",
             memo="PU supply - additional ICE & ERS elements beyond season allocation (2026 power unit)", c26="PU_SUPPLY", erp="PU_SUPPLY", plant="P34",
             limit_cat="PU_SUPPLY",
             truth=[("PU_SUPPLY", 260_000_000 - excess, 0, "within the Section A maximum price"),
                    ("RELEVANT", excess, _usd(excess, "EUR", d34), "season PU purchases above the Section A maximum (EUR 21.0m contract assumption)")])
    A("P34", p, "pu_above_max_price", "flag", "RELEVANT",
      f"Contract EUR 19.2m + this EUR 2.6m exceeds the EUR 21.0m Section A maximum (ctr-002 terms): EUR {excess / 100:,.0f} is Relevant.")
    p = line(posted=date(2026, 2, 26), acct="5010", dept="AERO", vendor=None, amount=25_000_000, ccy="GBP", entity="TECHNOLOGY",
             memo="Payroll Feb 2026 - sign-on payment - Technical Director (contract clause 4.2)", c26="EXCLUDED_PERSONS", erp="RELEVANT", plant="P38")
    A("P38", p, "excluded_person_in_relevant", "reclassify", "EXCLUDED_PERSONS",
      "The Technical Director is one of the three Excluded Persons; his sign-on payment is excluded with his Consideration (D5.1.1.d).")

    # ---- 2025 habits that the 2026 rules overturned -----------------------------------------------
    p = _find(st, "sporting_fine")
    p.erp, p.plant = "RELEVANT", "P39"
    A("P39", p, "sporting_fine_prior_year_habit", "reclassify", "FINES",
      "2025 precedent: sporting fines Relevant (ISS22 3.1(m) covered only Financial Regulations penalties). D5.1.1.m now excludes any FIA fine.")
    p = _find(st, "gp_ground_transport", "Car hire & transfers - Bahrain Grand Prix")
    p.erp, p.plant = "RELEVANT", "P40"
    A("P40", p, "ground_transport_prior_year_habit", "reclassify", "COMPETITION_TRAVEL",
      "2025 precedent: race-weekend road transport Relevant (ISS22 3.1(r) flights, rail, hotels only). D5.1.1.r adds road transport.")
    p = _find(st, "pe_depreciation", "Depreciation - machine tools", month=4)
    p.erp, p.plant = "DEPRECIATION", "P41"
    A("P41", p, "pe_depreciation_prior_year_habit", "reclassify", "RELEVANT",
      "2025 precedent: all depreciation excluded (ISS22 3.1(o)). Plant and equipment depreciation is inside the cap in 2026 (D6.1.1.k).")

    # ---- Applied Technologies payroll: no apportionment for generic client work in 2026 ----------------
    for ln in st.lines:
        if ln.dept == "APPLIED" and ln.acct in ("5010", "5050", "5230") and ln.vendor is None and ln.plant is None and ln.tag != "plant_contra":
            ln.plant = "P45"
            A("P45", ln, "non_f1_apportionment_not_permitted", "reclassify", "RELEVANT",
              "The 2025 precedent split Applied Technologies pay 60% Relevant / 40% Non-F1 (ISS22 allowed any Non-F1 activity). D5.1.1.h.c.A allows a "
              "salary share only for PU supply, Customer Team Support, FIA Projects or Standard Supply Components; generic client work is none of these, "
              "so the whole line is Relevant.")

    # ---- mixed invoices: split by bill line ---------------------------------------------------------------
    rng = st.rng("mixed_bills")
    dinners = [ln for ln in st.lines if ln.tag == "partner_dinner" and ln.plant is None]
    for ln in sorted(dinners, key=lambda x: x.posted)[::2] + sorted(dinners, key=lambda x: x.posted)[1:2]:
        partner = ln.memo.split(" - ")[1].replace(" partners evening", "")
        topup, lunch = G.money(rng, 1_200, 3_000), G.money(rng, 1_700, 3_000)
        ln.bill_lines = [(G.desc_sponsor_dinner(partner, ln.posted), ln.amount - topup - lunch),
                         (G.desc_canteen_topup(ln.posted), topup),
                         (G.desc_tunnel_lunch(ln.posted - timedelta(days=1)), lunch)]
        ln.bill_cats = [G.T_MARKETING, G.T_CANTEEN, G.T_TUNNEL]
        ln.keep_bill_draw, ln.plant = True, "P43"
        ln.memo = f"Hospitality - {partner} partners evening & build week catering (requester: Marketing)"
        A("P43", ln, "mixed_hospitality_invoice", "reclassify", "",
          "Grove Catering hospitality invoice coded MARKETING as a whole. Split by bill line: sponsor dinner MARKETING, canteen top-up CATERING, "
          "wind tunnel lunch RELEVANT (same description patterns as the 2025 split invoices).")
        for k, (cat, why) in enumerate([("MARKETING", "sponsor dinner (D5.1.1.a)"), ("CATERING", "factory canteen top-up at team premises (D5.1.1.z)"),
                                        ("RELEVANT", "offsite engineering lunch at Northbrook Wind Tunnel")], start=1):
            A("P43", (ln, k), "mixed_hospitality_invoice", "reclassify", cat, f"P43 bill line {k}: {why}", source="bill_line")
    canteens = [ln for ln in st.lines if ln.tag == "canteen" and ln.memo.startswith("Factory canteen service") and ln.plant is None
                and ln.posted.month not in (1, 8)]
    for ln in sorted(rng.sample(canteens, 5), key=lambda x: x.posted):
        lunch = G.money(rng, 1_700, 3_600)
        ln.bill_lines = [(ln.memo, ln.amount - lunch), (G.desc_tunnel_lunch(ln.posted - timedelta(days=rng.randint(1, 3))), lunch)]
        ln.bill_cats = [G.T_CANTEEN, G.T_TUNNEL]
        ln.keep_bill_draw, ln.plant = True, "P44"
        A("P44", ln, "offsite_lunch_in_canteen_invoice", "reclassify", "",
          "Weekly canteen invoice (CATERING) that also bills a wind tunnel session lunch. Split by bill line: canteen CATERING, offsite lunch RELEVANT.")
        for k, (cat, why) in enumerate([("CATERING", "factory canteen at team premises (D5.1.1.z)"),
                                        ("RELEVANT", "offsite engineering lunch at Northbrook Wind Tunnel: not premises catering")], start=1):
            A("P44", (ln, k), "offsite_lunch_in_canteen_invoice", "reclassify", cat, f"P44 bill line {k}: {why}", source="bill_line")
