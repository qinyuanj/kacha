import sys, zipfile, hashlib, json

z = zipfile.ZipFile(sys.argv[1])
res = {}
for i in z.infolist():
    if i.is_dir():
        continue
    h = hashlib.sha256()
    with z.open(i) as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    res[i.filename] = h.hexdigest()
s = json.dumps(sorted(res.items()), separators=(",", ":"))
print("python reference set=" + hashlib.sha256(s.encode()).hexdigest()[:16])
