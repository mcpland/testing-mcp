# Publishing to npm

Publishing is triggered by a GitHub Release with the `published` event. The
workflow builds and tests the release tag before publishing `testing-mcp`.

## Trusted publisher configuration

The npm trusted publisher for `testing-mcp` must match:

| Setting | Value |
| --- | --- |
| Organization or user | `mcpland` |
| Repository | `testing-mcp` |
| Workflow filename | `npm-publish.yml` |
| Environment name | Leave empty; the workflow does not use a GitHub environment |
| Allowed action | Direct publishing with `npm publish` |

The workflow uses a GitHub-hosted runner, Node 24, npm 11.21.1, and the
`id-token: write` permission. npm authenticates with OIDC and includes provenance;
no npm publish token is needed. Keep the workflow filename unchanged unless the
npm trusted publisher is updated as well. See the
[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Release procedure

1. Update `package.json` to the intended version and commit the change.
2. Create a tag matching the version, such as `v0.6.0` or `0.6.0`, on that commit.
3. Publish a GitHub Release for the tag. Stable versions publish to npm's `latest`
   dist-tag. For a version such as `0.7.0-rc.1`, mark the GitHub Release as a
   prerelease; the workflow publishes it to `next`.
4. Verify the publish workflow completed and the expected version is on npm.

Create the release tag from a commit containing the current workflow. Releasing
an older tag uses the workflow stored in that tag.

The workflow rejects mismatched release tags and prerelease flags before
installing project dependencies. It uses Yarn 1.22.22 with the committed lockfile,
runs the build and tests, and checks the package contents before publishing.
Publishing jobs for the same release tag cannot run concurrently. An already
published npm version cannot be overwritten by rerunning the workflow.

Pushes and pull requests run the same install, build, test, and package checks on
Node 20, 22, and 24. To run them locally with the pinned Yarn version:

```sh
corepack enable
yarn install --frozen-lockfile --non-interactive
yarn build
yarn test
npm pack --dry-run --json
```
