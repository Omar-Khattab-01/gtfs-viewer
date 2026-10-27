# GTFS Viewer

I built GTFS Viewer to make static transit feeds easier to read and review. In a regular text editor, long files quickly become difficult to follow: the header row disappears, similar columns blend together, and finding a problem can mean searching through millions of rows by hand.

The viewer opens a zipped feed directly in the browser and turns its text files into a navigable workspace. Column headings stay visible, fields have consistent colours, and large tables use virtual scrolling.

[Open GTFS Viewer](https://omar-khattab-01.github.io/gtfs-viewer/)

## What it does

- Open standard GTFS ZIP files without extracting them first.
- Browse text and CSV files with pinned headings and coloured columns.
- Move through large tables such as stop times and shapes.
- Search smaller files and wrap long cell values when needed.
- Keep up to three feeds open and switch between them.
- Run a feed check separately from the file viewer.
- Check required files and fields, empty values, duplicate keys, coordinates, dates, times, route types, colours, sequence order, and shape progression.
- Show files with errors or warnings and highlight the affected data.
- Read issue descriptions and move between highlighted rows.

## Review approach

I kept file browsing and feed checks separate so a feed can be explored before or after a check. Findings link back to the data that needs attention; they are a focused review aid rather than a claim of complete GTFS compliance.

Feed contents are processed locally in the browser.

## Author

Omar Khattab — [GitHub](https://github.com/Omar-Khattab-01)
