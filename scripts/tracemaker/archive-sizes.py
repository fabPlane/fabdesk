#!/usr/bin/env python3
"""List archive sizes and largest members without extracting their contents."""
import json
from pathlib import Path
import sys
import tarfile
import zipfile

for filename in sys.argv[1:]:
    path = Path(filename)
    if path.suffix == '.zip':
        with zipfile.ZipFile(path) as archive:
            members = [(m.filename, m.file_size) for m in archive.infolist() if not m.is_dir()]
    else:
        with tarfile.open(path) as archive:
            members = [(m.name, m.size) for m in archive.getmembers() if m.isfile()]
    print(json.dumps(dict(archive=path.name, bytes=path.stat().st_size,
        expandedBytes=sum(size for _, size in members),
        largestMembers=sorted(members, key=lambda item: item[1], reverse=True)[:12]), indent=2))
