# -*- coding: utf-8 -*-
"""
校验 D1 中的数据是否与旧后端基线一致。

用法（在 worker 目录下执行）：
    python scripts/verify_d1.py
基线文件：
    scripts/baseline_pages.json（由 scripts/export_legacy.py 的同期数据统计得出）
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASELINE = os.path.join(HERE, "baseline_pages.json")
WRANGLER = os.path.join(
    ROOT, "node_modules", ".bin", "wrangler.cmd" if os.name == "nt" else "wrangler"
)


def query(sql):
    """执行一条远程 SQL，返回第一段结果的 data 数组"""
    proc = subprocess.run(
        [WRANGLER, "d1", "execute", "web-profile-visitors", "--remote", "--json", "--command", sql],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = proc.stdout or ""
    start = out.find("[")
    if start < 0:
        raise RuntimeError("wrangler 输出无法解析：\n%s\n%s" % (out[-800:], proc.stderr))
    payload = json.loads(out[start:])
    return payload[0]["results"], payload[0]["success"]


def main():
    failures = []

    # 1) 总数校验
    rows, ok = query("SELECT COUNT(*) AS total FROM visitors")
    total = rows[0]["total"]
    print("D1 总数: %d" % total)

    if not os.path.exists(BASELINE):
        print("未找到基线文件 %s，跳过对比" % BASELINE)
        return 0

    with open(BASELINE, encoding="utf-8") as f:
        base = json.load(f)
    base_total = base["total"]
    print("基线总数: %d" % base_total)
    if total != base_total:
        failures.append("总数不一致：D1=%d 基线=%d" % (total, base_total))
    else:
        print("  ✓ 总数一致")

    # 2) 页面排行校验
    rows, _ = query("SELECT page, COUNT(*) AS count FROM visitors GROUP BY page ORDER BY count DESC, page ASC")
    actual = {r["page"]: r["count"] for r in rows}
    expected = base["pages"]

    print("\n页面排行对比（page: D1 / 基线）")
    for page in sorted(set(expected) | set(actual), key=lambda p: -expected.get(p, 0)):
        a = actual.get(page)
        e = expected.get(page)
        flag = "✓" if a == e else "✗"
        if a != e:
            failures.append("页面 %s 计数不一致：D1=%s 基线=%s" % (page, a, e))
        print("  %s %-20s %s / %s" % (flag, page, a, e))

    # 3) id 连续性校验
    rows, _ = query("SELECT MIN(id) AS mn, MAX(id) AS mx FROM visitors")
    if rows[0]["mn"] != 1 or rows[0]["mx"] != base_total:
        failures.append("id 区间异常：%s ~ %s" % (rows[0]["mn"], rows[0]["mx"]))
    else:
        print("\n  ✓ id 区间 1 ~ %d 连续" % base_total)

    print()
    if failures:
        print("校验未通过：")
        for f in failures:
            print("  - " + f)
        return 1

    print("全部校验通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
