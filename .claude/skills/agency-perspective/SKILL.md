---
name: agency-perspective
description: Use for any Stock-out Watch UI, feature, report, deck or copy decision. The product is built for a performance-marketing agency (Catalys) that runs ads for D2C brands: its job is to prove, month by month, which bestsellers were out of stock, when, and how much revenue that cost, so the agency is not blamed (or paid less) for revenue the brand lost to empty shelves, and so it can push brands to restock and protect ROAS. Also covers plain-language number writing and problem breakdown.
---

# Agency perspective

## Who we serve, in order
1. **The agency** (Catalys): keep clients, grow their sales and ROAS, and never get money deducted for a revenue drop the brand caused by running out of stock.
2. **The brand owner**: sees clearly what was out, when, and what it cost; gets a simple restock list.

Brand side is operations-heavy (reorder, suppliers, stock). Agency side is outcome-heavy (revenue, spend, ROAS, proof). When the two pull apart, design for the agency's proof first.

## What every feature must answer
- **Which bestsellers were out of stock, when (dates), and for how long?**
- **How much revenue did that cost, month by month?** A history that builds up every month and can be shown to the brand.
- **If it had been in stock, what would it have sold?** Based on its normal pace (6–12 months of in-stock days), not one month.
- **What is in stock right now that we should sell (push in ads)?** And what to pause because it can't be bought.
- **Is the brand's revenue dip explained by stock-outs?** Compare actual revenue with "revenue if bestsellers had been in stock".

## Data rules
- Pace (speed) comes from the last 6–12 months, only days the product was in stock. Show average per day, week and month, and the seasonal pattern (festive peak, post-peak dip). Never judge a product on 30 days alone.
- Use Shopify report totals (ShopifyQL) for long history; don't download a year of orders.
- Stock-outs are measured on **available** stock (what shoppers can buy), never "on hand".
- Every number must be checkable against Shopify. Keep the audit trail.
- Show COGS-aware numbers when cost exists (profit lost, cash needed); say "at selling price" when it doesn't.

## UI rules
- Every product row shows **image, name and SKU**.
- Lead with bestsellers. Default sort = money lost.
- Month-wise view is a first-class page, exportable for client meetings.
- One idea per screen; the decision first, detail on demand.

## Writing numbers (copy)
- Say the number, then what it means, in one short sentence a brand owner understands: "Oakwood was out for 20 days in November. That cost about ₹74k in sales."
- Plain words, no jargon ("in stock", "sold", "lost sales", "restock or drop?"). Indian money format (₹74k, ₹4.8 L, ₹1.3 Cr).
- Round for reading, keep exact numbers in the detail and tooltips.
- Always say the period and the date the numbers were taken.

## Working style
- Break the problem down before building: who asks, what they decide, what proof they need, what data proves it.
- When a tangent comes up, note it, then come back to the main goal: bestsellers out of stock → revenue lost → proof by month.
- Check every claim against Shopify before it goes in front of a brand.

## Off the screens (1.5.0, owner's decision 25 Nov 2026)
Nothing from the brand owner's side: no reorder, restock quantities, suppliers, purchase orders, lead times, overstock, margins, slow-seller or "refill or drop" decisions. A product that stays empty is the client not restocking: show since when, how often, what it cost. Judge on long patterns (12 months), never on one month.
