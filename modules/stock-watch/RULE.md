# The rule (2.0)

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

The variants making the first 80% of all Shopify net sales (drafts count too) in the (up to) 365 days before the quarter began. Real sales only; the row that crosses 80% is in. Gift lines (average price under ₹100 over the whole record) are left out of the list, of the 80%, and of the month pattern. The window ends the day before the quarter began. The list is fixed for the whole quarter. Months before the list's first quarter use that first list.

## Money missed and could have earned (estimates)

    missed = speed × month × price × days empty
    could have earned = sold + missed

Only for best sellers:

- **Speed**: net pieces ÷ Full days, twice: over up to 365 days ending on the 4th day before the gap began, and over the last 60 Full days of those. Each with the months evened out (the sum of the days' month numbers instead of the count of days). The slower of the two. Nothing after the gap is used.
- **Month**: how that month ran: for the best sellers Full on 80%+ of the month's days with 60+ Full days outside it, the sum of their speeds that month ÷ the sum of their speeds over the rest of the record. The product itself left out; gift lines never count; under 5 of them: 1.
- **Price**: net sales ÷ pieces on those last 60 Full days.
- **Days empty**: 1 for an Empty day, ½ for a Half day. What it sold that day comes off: pieces missed that day = the smaller of (days × speed) and (speed − sold), never under 0.
- **After 60 days empty** (from the gap's first day): shown, "if people still wanted it", never added.
- **No ₹** (days still shown): not a best seller; gap already empty when it came on the website or the record began; under 30 Full days or under 5 pieces in the last 60 Full days; another variant of the same product was Full that day.
- **Cut**: when a month's test (below) comes out too high, all its ₹ are divided by 1 + how much. Never raised.
- **A month shows no ₹** when under 5 of its gap parts carry ₹, its test is over 25% too high, or fewer than 20 tests ran.
- **Range**: 400 replays. Each draws, per month, how far that month's whole test was off (its products drawn again at random), and per estimate how far one test was off around that. The 5th and 95th of the 400, never tighter than ±15%; the low end also cut by the comeback score when under 1. Under 5 estimates: no range.

Why these and nothing more (tested on 13 months, the longest stock record Shopify holds that adds up): year speed alone is right for products that stayed in stock but 20–25% too high for ones that ran out, so the slower of two; without the month it is 30% off in Oct and Jun; over 60 days there are only 2 comebacks to test; for products that aren't best sellers it is 40–55% too high, so they show speed and days only.

## Proof

- **Hidden-sales test**: on the 1st and 16th of every month, each best seller that then stayed Full on 80%+ of the next 30 days is treated as if it had run out (windows cut at the last full day, 14 days at least). Only ones whose speed is under 1 a day count: they sell like the ones that run out (95% of the money). The same rule guesses its Full days; compared with Shopify's net sales of those days, counted in the month they fall in. 20+ tests or the month shows no ₹. The same test over 60 days is shown beside it.
- **Comeback test**: days 4–30 after a real gap of 3+ empty days ended: what sold against what the rule would have said from before the gap.

## Lock

A month is locked 3 days after it ends: empty days, speed, month, price, cut, ₹, range and score are saved and never worked out again under this rule. The best-seller list is locked on its quarter's first report. The current month says "so far" and can still move.

## Limits (said on the screen)

- A missed sale can't be seen. The test proves how well the guess works on products that were in stock, not the missed sales themselves.
- Someone may have bought another product instead. That isn't taken off.
- Our record begins on the first day Shopify's two reports both hold; gaps in the first weeks carry no ₹.
