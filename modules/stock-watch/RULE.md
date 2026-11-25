# The rule (3.0)

One rule makes every number on the screen. Nothing else may add, hide or change a number. Changing anything here = a new rule number, run hidden beside this one for a full quarter before it may replace it.

## Facts (what Shopify recorded)

1. **A row** is one variant (a size or colour is its own row). Every page counts rows the same way. Untracked variants are left out.
2. **Sold and price paid**: Shopify's own sales report per variant per store day (`net_items_sold`, `net_sales`): after discounts and returns, without GST. A return counts on the day it is booked.
3. **Stock at each day's end**: stock now, walked back through Shopify's log of changes to "available".
4. **On the website**: from its creation (or first publish), leaving out days it was draft or archived; a row created inside the record starts on its first day in stock. Draft now: up to the day it went off.
5. **The kind of day**
   - Full: stock above 0 at the start and the end (or 0 at both ends but pieces sold beyond an oversell: refilled and sold out inside the day).
   - Empty: 0 or less at both ends.
   - Half: one end above 0, the other not. (Its first day on the website is Full when it ends with stock: not "ran out".)
6. **A gap** is a run of Empty and Half days. A Half day that ends with stock closes it. Empty days = Empty + half of Half. A gap whose last day is the last full day and ends at 0 or less is open ("out now").
7. A variant set to keep selling at 0 is never empty.

## Best sellers

The variants making the first 80% of all Shopify net sales (drafts count too) in the (up to) 365 days before the quarter began. Real sales only; the one that crosses 80% is in. Gift lines (average price under ₹100 over the whole record) are left out of the list, the like products and the money; their days are still shown. Each month uses its own quarter's list; a quarter with under 60 days of record before it uses the next one's; a store newer than that uses its first 90 days.

## Money missed and could have sold (estimates, every product)

    missed = speed × like-for-like × price × days empty
    could have sold = sold + missed

- **Speed**: weighted average of net pieces per Full day, newer days counting more (half-life 60 Full days), up to the 4th day before the gap. Not under 0. Needs 30+ Full days in the 365 days before and 1+ piece on the last 60 Full days.
- **Like-for-like**: for the gap's days in one calendar month (under 14 days widened to 14 from the first, moved back if past the last full day): every other product (not the same product) Full on 80%+ of them, with its own speed frozen on the same day. Weight 1 ÷ (1 + 0.5 × its guess). All = (Σ weight × sold + 2) ÷ (Σ weight × guess + 2). Its speed tier (pieces per 60 days: under 3, 3–8, 8–20, 20–60, 60+) = (Σ weight × sold + 8 × all) ÷ (Σ weight × guess + 8). The tier's is used, 0.25 to 4.
- **Price**: net sales ÷ pieces on its last 60 Full days before the gap.
- **Days empty**: 1 for an Empty day, ½ for a Half day. What it sold that day comes off: the smaller of (days × speed) and (speed − sold), never under 0. Another variant of the same product Full that day: 0.
- **After 60 days empty** (from the gap's first day): shown, never added. Too few gaps that long ended to test it.
- **No ₹** (days still shown): too little history, no recent sales, already empty when the record began, sells at 0, gift line.
- **Range** (90%): how far the tests below were off, by product (2,000 resamples), best sellers and others apart, a random mix of replays and comebacks, with counting noise (by product) and ±5.5% for the choice of model. The low end is never above what real comebacks alone say. Under 5 entries: no range.

Why this model: 19 models (plain averages, weighted averages, intermittent-demand, Bayesian, Poisson regression, boosted trees, the 2.0 rule) × 3 ways to use other products, scored on windows that began by Sep 2026 (some run into October); the simplest of the ones that can't be told apart. The half-life anywhere from 30 to 180 days, and the 14, 0.5, 2 and 8, move the total under 3% either way (a half-life of 15: +5%).

## Proof (on the page, worked out again with new data)

- **Comebacks**: days 4–30 after a real gap of 2+ empty days ended, with 7+ Full days in them, against the guess from before the gap.
- **Replays**: 40 per product with 45+ Full days: a pretend opening stock of 10–50 days' sales, real sales until it would be gone, then a gap length drawn from real gaps; the real sales of those days (half of them Full at least) are the truth.

Each with its 95% interval (by product).

## Lock

A month is locked 3 days after it ends: empty days, speed, like-for-like, price, ₹ and range are saved and never worked out again under this rule. The best-seller list is locked on its quarter's first report. The current month says "so far" and can still move.

## Limits (said on the screen)

- A missed sale can't be seen. The test proves how well the guess works on products that were in stock, not the missed sales themselves.
- Someone may have bought another product instead. That isn't taken off.
- Our record begins on the first day Shopify's two reports both hold; gaps in the first weeks carry no ₹.
- Money on products that are not back yet can't be checked against a comeback; the page says how much that is.
- The range held 86–88% of the time when the method was checked blind (before this code was written, in a separate build), not the 90% it aims at. One product: 88%, checked on the same data, so not blind.
