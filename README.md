# GTFS Viewer

GTFS Viewer was made to make static GTFS feeds easier to read and review. In a
regular text editor, long files quickly become difficult to follow: the header
row disappears, similar columns blend together, and finding a problem can mean
searching through millions of rows by hand.

GTFS Viewer opens a zipped feed directly in the browser and turns its text files
into a clear, navigable workspace. Column headings remain visible while
scrolling, each field is colour-coded, and large files remain responsive.

[Open GTFS Viewer](https://omar-khattab-01.github.io/gtfs-viewer/)

## Features

- Open standard GTFS ZIP files without extracting them first
- Browse every text and CSV file in a feed
- Keep column headings pinned while scrolling
- Separate fields with consistent column colours
- Move smoothly through large files such as `stop_times.txt` and `shapes.txt`
- Search smaller files and wrap long cell values when needed
- Keep up to three feeds open and switch between them
- Run a feed check separately from the file viewer
- Check required files and fields, empty values, duplicate keys, coordinates,
  dates, times, route types, colours, sequence order, and shape progression
- See which files contain errors or warnings
- Turn issue highlights on or off in the viewer
- Read an issue description beside the affected data
- Move between individual issues and jump to the next highlighted row
- Process every feed locally so its contents never leave the browser

## Author

Omar Khattab — [omar-khattab-01](https://github.com/omar-khattab-01)
