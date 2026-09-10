# GTFS Viewer

GTFS Viewer is a browser-based viewer for static GTFS feeds. Open a zipped feed,
browse each text file, and keep column headings visible while scrolling through
large datasets.

## Features

- Opens standard GTFS `.zip` files locally in the browser
- Keeps uploaded transit data on the user's device
- Lists every `.txt` and `.csv` file in the feed
- Uses pinned, color-coded column headers
- Virtualizes very large files such as `shapes.txt` and `stop_times.txt`
- Supports search for normal-sized files and optional cell wrapping
- Checks required files and columns, duplicate keys, blank IDs, coordinate
  ranges, dates, times, route types, colours, and sequence ordering
- Works on desktop and mobile browsers

## Local development

Node.js 22 or newer is required.

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

## GitHub Pages

Pushes to `main` are automatically built and deployed by the GitHub Actions
workflow in `.github/workflows/deploy-pages.yml`.

## Privacy

GTFS feeds are decompressed and read entirely in the browser. The application
does not upload feed contents to a server.

## Author

Omar Khattab — [omar-khattab-01](https://github.com/omar-khattab-01)
