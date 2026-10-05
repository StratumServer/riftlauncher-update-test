# riftlauncher-update-test

This repository exists to test how RiftLauncher updates itself from a beta to a stable release. It is not a release channel.

Its releases are throwaway test builds. Do not download or install anything from here. To get RiftLauncher, use https://github.com/StratumServer/RiftLauncher/releases instead.

v1.7.0-beta.13 is a prerelease, and v1.7.0 is a regular release so that the beta has a stable version to find. Both are built from the same RiftLauncher development tree, and only the version number differs. Their update feed points at this repository, so they never offer anything from the real releases.

v1.7.1 came later, to test a fix to the update on Windows, and holds Windows files only. It is a RiftLauncher development commit packaged as 1.7.1: the update that a build of the same commit packaged as 1.7.0 finds. That 1.7.0 build is installed straight from the workflow's artifact and is not published here.

The releases and this repository can be deleted at any time.
