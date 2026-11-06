import sys, os, json, zipfile

# 写到不可 seek 的输出，强制 data descriptor（与服务端 ZipWriter::new_stream 一致）。
# 图片 stored，JSON deflate；外加一个 20MB 的 deflate 条目测解压路径。
target = sys.argv[1]


class Unseekable:
    def __init__(self, f):
        self.f = f

    def write(self, b):
        return self.f.write(b)

    def flush(self):
        self.f.flush()


with open(target, "wb") as raw:
    with zipfile.ZipFile(Unseekable(raw), "w") as z:
        z.writestr(zipfile.ZipInfo("manifest.json"), json.dumps({"v": "0.3.0"}), compress_type=zipfile.ZIP_DEFLATED)
        for i in range(80):
            d = f"tasks/t{i:03d}/"
            z.writestr(zipfile.ZipInfo(d + "task.json"), json.dumps({"i": i, "pad": "x" * 2000}), compress_type=zipfile.ZIP_DEFLATED)
            with z.open(zipfile.ZipInfo(d + "result.png"), "w") as f:
                for _ in range(7):
                    f.write(os.urandom(512 * 1024))
        big = zipfile.ZipInfo("tasks/big/deflated.bin")
        big.compress_type = zipfile.ZIP_DEFLATED
        with z.open(big, "w") as f:
            for _ in range(40):
                f.write(os.urandom(256 * 1024) + bytes(256 * 1024))

z = zipfile.ZipFile(target)
info = z.infolist()
print(os.path.getsize(target), len(info), hex(info[1].flag_bits), info[2].compress_type, info[-1].compress_type)
