# Project sharing UI evidence

Actual, unaltered captures of the packaged Fabdesk app using an isolated local profile and synthetic three-board project. The main sharing-flow captures correspond to source commit903b2f8b; signed-out captures show the later sign-in prompt refinement. These are implemented screens, not generated concepts.

## Current header

The header uses one control: Share while private, Shared when a published link is active. Both open sharing settings.

![Compact Shared control](header-after.png)

## Current sharing dialog

One access dropdown, primary Copy link action, short privacy/freshness notes and explicit create/update/disable actions.

![Simplified sharing dialog](dialog-after.png)

## Copy confirmation and secondary options

![Copy confirmation](copy-feedback.png)

![More options with local preview, review ZIP and publication details](more-options.png)

## Signed out

Being signed out leaves the normal Share action in the header. The sign-in warning and account action appear inside the dialog. These November9 captures use the existing expired local test session; no publication or access mutation was performed.

![Normal Share action while signed out](signed-out-header.png)

![Sign-in warning inside the sharing dialog](signed-out-dialog.png)

## Previous layout

![Previous header with separate Share label and visibility badge](header-before.png)

![Previous sharing dialog with access cards and large information panel](dialog-before.png)

The visible walkthrough verified copy feedback, the native access dropdown and unsaved-choice behavior, local preview, and entry into the existing ZIP flow. This presentation follow-up preserved the active test link; earlier integration testing covered actual publication and revocation.
