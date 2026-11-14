A-Company for Windows x64 - no installation required

1. Extract the entire ZIP into a writable local folder.
2. Open A-Company.exe from that folder. Keep all adjacent files and resources.
3. Connect a model to start using the built-in local workspace.

No separate Node.js, PostgreSQL, or Docker installation is required for the
built-in engine. Cloud models need an internet connection and an account or key;
local models and optional CLI tools must be configured separately.

This build is unsigned. Windows may warn or block it according to system policy.
Do not disable Windows security controls to run it.

Workspace data is stored separately in %APPDATA%/A-Company, not inside this ZIP.
Close the app before backing up that entire directory, including its encryption
material. Deleting the extracted app does not delete the workspace.

Updates are manual: close A-Company, extract a new release into a fresh folder,
and open the new A-Company.exe. Do not overwrite files while the app is running.
The built-in installer updater is disabled for this ZIP distribution.

Zero-Docker Lite CLI and Docker/server remain available alongside this desktop
build. Documentation and releases: https://github.com/phuocka/a-company
