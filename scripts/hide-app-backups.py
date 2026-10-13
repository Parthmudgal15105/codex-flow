#!/usr/bin/env python3
"""Keep rollback bundles out of Spotlight and Launch Services without deleting them."""
from pathlib import Path
import json, subprocess

def hide_backups(directory):
    directory = Path(directory)
    # The .noindex suffix excludes the whole tree, including nested helper apps.
    if directory.name == 'backups' and not directory.is_symlink():
        excluded = directory.with_name('backups.noindex')
        if excluded.exists():
            raise FileExistsError(excluded)
        if directory.exists():
            directory.rename(excluded)
        else:
            excluded.mkdir(parents=True)
        directory.symlink_to(excluded.name, target_is_directory=True)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / '.metadata_never_index').touch()
    register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
    moved = []
    for app in directory.glob('*.app'):
        destination = app.with_suffix('.app-backup')
        if destination.exists():
            raise FileExistsError(destination)
        subprocess.run([register, '-u', str(app)], check=False, capture_output=True)
        app.rename(destination)
        moved.append({'from': str(app), 'to': str(destination)})
    return moved

if __name__ == '__main__':
    print(json.dumps(hide_backups(Path.home() / 'Library/Application Support/CodexPP/backups'), indent=2))
