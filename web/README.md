# Courtside 3D Shot Lab

Static Vite + Three.js site for exploring 2025 NBA and WNBA shot zones. The site imports the existing processed CSVs from `../data/processed/` and does not modify the older experience under `../sites/`.

## Run locally

```powershell
cd D:\mlbasket\web
npm.cmd install
npm.cmd run dev
```

## Build and preview

```powershell
npm.cmd run build
npm.cmd run preview
```

The app is client-side only. Vite emits the two CSV files as static assets, so the hosted site needs no API or server runtime.

## GitHub Pages

The repository-root workflow at `../.github/workflows/deploy-web.yml` builds only `web/` and publishes `web/dist/`. In GitHub, choose **Settings → Pages → Build and deployment → Source → GitHub Actions**. Relative asset paths work for both a project repository and a user site.

The workflow deploys on pushes to `main` that change the site, workflow, or source CSVs. `D:\mlbasket` is not currently a Git repository, so initialize/connect it to GitHub and push `main` before the workflow can run.
