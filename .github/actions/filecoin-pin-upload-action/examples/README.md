# Workflow Examples

This directory contains example workflows for using the Filecoin Upload Action in different scenarios.

## 📂 Directory Structure

```
examples/
├── README.md                     # This file
├── single-workflow/              # Simple, same-repo PRs only
│   └── upload.yml
└── two-workflow-pattern/         # Secure workflow pattern
    ├── build-pr.yml              # Untrusted build workflow
    └── upload-to-filecoin.yml    # Trusted upload workflow
```

## 🚀 Quick Start

### Recommended: Two-Workflow Pattern

✅ **This is the recommended and default pattern.**

**Use when:**
- You want maximum security
- You want the secure default behavior

**Setup:**
1. Copy both files from `two-workflow-pattern/` to `.github/workflows/` in your repo
2. Set `WALLET_PRIVATE_KEY` secret in your repository settings
3. Update the build steps in `build-pr.yml` to match your project
4. Adjust hardcoded `minStorageDays` and `filecoinPayBalanceLimit` in `upload-to-filecoin.yml` to your needs

**That's it!** The action automatically handles:
- ✅ Building CAR files from your build artifacts
- ✅ Uploading to Filecoin with proper security
- ✅ Commenting on the PR with results

**Security:** ✅ Financial parameters are hardcoded in the trusted workflow.

**This is the only pattern shown in the main README.** The single-workflow pattern is available but not recommended.

⚠️ **Security Warning**: Only use if you fully trust all contributors and don't accept fork PRs.

**Use when:**
- You fully trust all contributors with write access
- You understand the security implications

**Setup:**
1. Copy `single-workflow/upload.yml` to `.github/workflows/` in your repo
2. Set `WALLET_PRIVATE_KEY` secret in your repository settings
3. Update the build steps to match your project

**Security:** ⚠️ Same-repo PRs can modify workflow files before merging.

**Note:** This pattern is intentionally not documented in the main README to encourage use of the secure two-workflow pattern.

---

## 📝 Usage Instructions

### 1. Copy Workflow Files

**Recommended:** Copy the two-workflow pattern files:

```bash
cp examples/two-workflow-pattern/*.yml .github/workflows/
```

### 2. Configure Secrets

Add the following secret to your repository (Settings → Secrets and variables → Actions):

- `WALLET_PRIVATE_KEY` - Your Filecoin wallet private key with USDFC funds

### 3. Customize Build Steps

Update the build section in the workflow to match your project:

```yaml
- name: Build
  run: |
    npm install
    npm run build
    # Output should go to 'dist' directory
```

### 4. Adjust Financial Parameters

Set these in `upload-to-filecoin.yml` (hardcoded for security):

```yaml
minStorageDays: "30"           # Ensure 30 days of funding
filecoinPayBalanceLimit: "0.10" # 10 cents max per run (0.10 USDFC)
```

### 5. Update Action Version

Replace `sgtpooki/filecoin-upload-action@v1` with the actual action reference:

```yaml
uses: sgtpooki/filecoin-upload-action@v1.0.0  # Pin to a specific version
```

---

## 🔒 Security Considerations

### Single Workflow Pattern

**Risks:**
- Same-repo contributors can modify workflow files in PRs
- Contributors can change spending limits before merging
- No protection against malicious same-repo PRs

**Mitigations:**
- Enable branch protection on main
- Require code review for all PRs
- Use CODEOWNERS for workflow files
- Set GitHub Environments with approval requirements

### Two-Workflow Pattern

**Protection:**
- ✅ Financial limits hardcoded in main branch
- ✅ `workflow_run` always uses main branch workflow
- ✅ Only build artifacts cross trust boundary

**Additional Mitigations:**
- Enable branch protection on main
- Require code review for workflow file changes
- Use CODEOWNERS for `.github/workflows/*`

---

## 🧪 Testing

### Test Single Workflow
1. Create a branch in your repo
2. Make a change to trigger the build
3. Open a PR
4. Workflow should run and upload to Filecoin
5. PR should get a comment with IPFS CID

### Test Two-Workflow Pattern
1. Create a branch in your repo
2. Make changes and open a PR
3. Both workflows should run in sequence
4. Build workflow should complete with no secrets
5. Upload workflow should complete and comment on PR

---

## 📚 Additional Resources

- [Full Usage Guide](../USAGE.md) - Complete documentation
- [Main README](../README.md) - Action overview and inputs

---

## 🧪 Testing Your Setup

### Test with Same-Repo PR
1. Create a branch in your repo
2. Make a small change and open a PR
3. Both workflows should run automatically
4. Check for PR comment with IPFS CID

### Verify Security
- ✅ PR cannot modify `minStorageDays` or `filecoinPayBalanceLimit` values (they're hardcoded in main branch)
- ✅ Only the build output crosses the trust boundary

---

## 🆘 Troubleshooting

### "Artifact not found" in upload workflow
- Build workflow must complete successfully first
- Artifact retention is 1 day by default (artifacts auto-named by action)

### "No PR context" in workflow_run
- PR metadata is automatically handled by the action
- Ensure build workflow ran on `pull_request` event
- Check that PR metadata artifact was created in build step

### Comments not appearing on PR
- Verify `pull-requests: write` permission is granted
- Check `github_token` is provided to the action (auto-provided by default)
- PR number is automatically detected from metadata
- Look for errors in the "Comment on PR" step

### Secrets not available
- Check repository secret settings
- Workflow files: Verify secret names match exactly

---

## 💡 Tips

1. **Pin action versions** - Use `@v1.0.0` instead of `@main` for stability
2. **Start conservative** - Set low `filecoinPayBalanceLimit` limits initially
3. **Monitor costs** - Check your wallet balance regularly
4. **Test thoroughly** - Verify security and functionality
5. **Use CODEOWNERS** - Require security team review for workflow changes

