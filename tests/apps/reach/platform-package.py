#!/usr/bin/env python3
"""Exercise platform package naming/refusal in an independent app copy."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

source = Path(__file__).resolve().parents[3] / "apps/reach"
mode = sys.argv[1]
root = Path(tempfile.mkdtemp(prefix="platform-package-"))
app = root / "apps/reach"
shutil.copytree(source, app, symlinks=True, ignore=shutil.ignore_patterns("dist"))
shutil.copyfile(source.parents[1] / "LICENSE", root / "LICENSE")
def command(args, env=None):
    result = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True, timeout=60)
    return result
for args in (["git", "init", "-q"], ["git", "add", "apps"], ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Package fixture"]):
    result = command(args)
    assert result.returncode == 0, result.stderr
env = dict(os.environ)
if mode == "refusal":
    bindir = root / "bin"
    bindir.mkdir()
    stub = bindir / "uname"
    stub.write_text("#!/bin/bash\ncase $1 in -s) printf 'SunOS\\n';; -m) printf 'x86_64\\n';; *) printf 'SunOS\\n';; esac\n")
    stub.chmod(0o755)
    env["PATH"] = str(bindir) + ":" + env["PATH"]
result = command(["make", "-C", str(app), "package"], env)
(root / "package.stdout").write_text(result.stdout)
(root / "package.stderr").write_text(result.stderr)
print("package evidence: " + str(root))
if mode == "refusal":
    assert result.returncode != 0 and "sunos" in (result.stdout + result.stderr).lower(), "unsupported platform was not named/refused"
    assert not (app / "dist").exists() or not list((app / "dist").iterdir()), "unsupported platform wrote dist files"
else:
    assert mode == "host" and result.returncode == 0, result.stderr
    system = {"Linux": "linux", "Darwin": "macos"}[os.uname().sysname]
    arch = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}[os.uname().machine]
    name = f"reach-2.0-{system}-{arch}.tar.gz"
    archive = app / "dist" / name
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert Path(str(archive) + ".sha256").read_text().split() == [digest, name]
    with tarfile.open(archive) as packed:
        assert "lib/reach-machine-id" in packed.getnames()
    again = command(["make", "-C", str(app), "package"], env)
    assert again.returncode == 0 and hashlib.sha256(archive.read_bytes()).hexdigest() == digest
print("PASS platform package " + mode)
