# The rule (4.0)

One rule makes every number on the screen. Nothing else may add, hide or change a number. Changing anything here = a new rule number. (4.0 replaced 3.0 at once on 26 Nov 2026, on the agency's call, after the tests below; the usual quarter beside the old rule was skipped.)

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

    missed = speed × busy × price × days empty        (× 0.74 for a product off that quarter's best-seller list)
    could have sold = sold + missed

- **Speed**: net pieces ÷ Full days, over its Full days in the 90 calendar days before the gap. Needs 60+ such days, 1+ piece and net sales above 0.
- **Price**: net sales ÷ pieces on those same days. So speed × price = the ₹ it makes a Full day.
- **Busy**: the shop's net sales that day, this variant's own taken out, ÷ the same on the speed's days. Not under 0.
- **Days empty**: an Empty day 1, less what it still sold that day (never under 0). The Half day it ran out ½ (what it sold before it ran out does not come off). The Half day it came back 0. Another variant of the same product Full that day: 0.
- **× 0.74 off the list**: on 1,741 normal in-stock periods (nothing ran out), products off the best-seller list sold 0.74 of what their last 90 days said; best sellers 1.00. Tests below get the same 0.74.
- **After 60 days empty** (from the gap's first day): shown, never added.
- **No ₹** (days still shown): under 60 Full days in the 90 before, no recent sales, already empty when the record began, sells at 0, gift line.
- **Range** (90%): how far the tests below were off, by product (2,000 resamples), best sellers and others apart, a random mix of replays and comebacks, with counting noise (by product) and ±5.5% for the choice of model. The low end is never above what real comebacks alone say. Under 5 entries: no range.

Why this rule (26 Nov 2026): plain to explain, and it beat 3.0 on best sellers (comebacks −13% → +7%, replays −17% → −6%, placebo +0%). Three separate critics (data, demand, tests) checked every step; what they changed: 60 days not 30 (short histories ran +79% high), the run-out day ½ with nothing taken off (it sells 2.7–3.5× a normal day before it empties), the comeback day 0, × 0.74 off the list. 90 days not 365: per product the miss doubles over a year (14% → 31%). Busy by day, week or month: the same within 1%.

## Proof (on the page, worked out again with new data)

- **Comebacks**: days 4–30 after a real gap of 2+ empty days ended, with 7+ Full days in them, against the guess from before the gap.
- **Replays**: 40 per product with 45+ Full days: a pretend opening stock of 10–50 days' sales, real sales until it would be gone, then a gap length drawn from real gaps; the real sales of those days (half of them Full at least) are the truth.

Each with its 95% interval (by product).

## Lock

A month is locked 3 days after it ends: empty days, speed, like-for-like, price, ₹ and range are saved and never worked out again under this rule. The best-seller list is locked on its quarter's first report. The current month says "so far" and can still move.

## Limits (said on the screen)

- A missed sale can't be seen. The test proves how well the guess works on products that were in stock, not the missed sales themselves.
- Someone may have bought another product instead, or bought it later. That isn't taken off; daily sales can't tell.
- It is net sales (after discounts and returns, no GST, no shipping), not profit.
- Our record begins on the first day Shopify's two reports both hold; gaps in the first weeks carry no ₹.
- Money on products that are not back yet can't be checked against a comeback; the page says how much that is.
- The range is not yet checked blind for this rule.
