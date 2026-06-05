# Workflow Examples

Ready-to-use GitHub workflow files for the Filecoin Pin Upload Action.

## 📂 What's Here

```
examples/
├── two-workflow-pattern/         # Recommended: Secure pattern
│   ├── build.yml                 #   - Untrusted build (no secrets)
│   └── upload-to-filecoin.yml    #   - Trusted upload (has secrets)
├── single-workflow/              # Alternative: Trusted repos only
│   └── build-and-upload.yml      #   - All-in-one (simpler but less secure)
└── cli-recipe/                   # No composite action: run the filecoin-pin CLI directly
    └── upload-with-cli.yml       #   - `filecoin-pin add` / `import` in your own steps
```

## 🚀 Quick Setup

### Recommended: Two-Workflow Pattern

**Copy the files:**
```bash
cp examples/two-workflow-pattern/*.yml .github/workflows/
```

**Customize:**
1. Add `FILECOIN_WALLET_KEY` secret in your repository settings
2. Update build steps in `build.yml` for your project
3. Adjust `minRunwayDays` and `maxBalance` in `upload-to-filecoin.yml`

**Done!** Open a PR to see it in action.

**Why this two-workflow approach?**
The recommended pattern is a **two-workflow approach**:
1. **Build workflow** (untrusted) - Builds your content, publishes artifacts.  This workflow never sees wallet secrets.
2. **Upload workflow** (trusted) - Downloads artifacts, creates IPFS CAR, uploads to Filecoin with secrets.  This upload workflow runs from the `main` branch, meaning PR branches can't modify hardcoded limits until merged. 

Note: this approach supports **same-repo PRs only**.  Fork PR support is disabled for security.

### Alternative: Single-Workflow Pattern

⚠️ **Only for trusted repositories** where all contributors have write access.

```bash
cp examples/single-workflow/build-and-upload.yml .github/workflows/
```

Then add the `FILECOIN_WALLET_KEY` secret and customize the build steps.

## 📚 Full Documentation

See the [main README](../README.md) for complete usage guide including security best practices, versioning, and caching details.

See [action.yml](../action.yml) for detailed input/output reference.

## 🔍 What Each File Does

**Two-Workflow Pattern:**
- `build.yml` - Runs on every PR, builds your project, uploads artifacts (no secrets)
- `upload-to-filecoin.yml` - Runs after build succeeds, downloads artifacts, uploads to Filecoin (has secrets)

**Single-Workflow Pattern:**
- `build-and-upload.yml` - Does everything in one job (build + upload)
