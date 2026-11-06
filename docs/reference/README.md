# Reference data

Data kept for later features (docs/ROADMAP.md), not read by the app yet.

## solar-terms-1900-2050.json

From a Taiwanese 閏月節氣表 (1900–2050), received 2026-10-14. Dates are in UTC+8.

- `terms`: the 24 solar terms in order, 小寒 first (traditional names, as in the source).
- `solarTerms`: for each year 1900–2050, the date of each term, in that order.
- `leapMonths`: each year with a leap month: which month, 29 or 30 days, its first and last
  day, and the term it contains.

Checked against ePet on 2026-10-14: all 55 leap months (month, first day, length) agree
with `src/features/anniversary/lunar.ts`, and Qingming and the winter solstice 2026–2050
with `holiday-dates.json`. Every leap month contains the term it lists.

Errors in the source, not carried into the data:

- 2017 is labelled 民國一百零三年; it is 民國一百零六年 (the row's leap month, 閏六月
  7.23–8.21, is right).
- The leap-month list ends at 2047 although the table says 1900–2050: 2050 has a 閏三月
  (ePet's lunar data has it).
- The PDF's text uses CJK compatibility characters for some characters (六, 立, 露, 年,
  曆, 零, 降): normalise to NFKC before reading it.
