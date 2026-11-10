from __future__ import annotations

import math
import re
from datetime import datetime, timezone

from .util import now_ms, round_to

_HAN_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x2F800, 0x2FA1F))
_HAN = "".join(f"{chr(low)}-{chr(high)}" for low, high in _HAN_RANGES)
_NON_TOKEN_RE = re.compile(f"[^{_HAN}a-z0-9]+")
_WS_RE = re.compile(r"\s+")
_DATE_ONLY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_DAY_MS = 86400000
_NAN = float("nan")


def _text(value) -> str:
    return "" if value is None else str(value)


def _pick(options: dict, *names: str, default=None):
    for name in names:
        value = options.get(name)
        if value is not None:
            return value
    return default


def _iso_now() -> str:
    moment = datetime.now(timezone.utc)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"


def _epoch_ms(value) -> float:
    if value is None:
        return None
    if isinstance(value, bool):
        return float("nan")
    if isinstance(value, (int, float)):
        return float(int(value))
    raw = _text(value).strip()
    if not raw:
        return float("nan")
    if raw.endswith(("Z", "z")):
        raw = raw[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        try:
            return float(int(raw))
        except ValueError:
            return float("nan")
    if moment.tzinfo is None:
        moment = moment.replace(
            tzinfo=timezone.utc if _DATE_ONLY_RE.match(_text(value).strip()) else None
        )
    return float(int(moment.timestamp() * 1000))


def tokenize(text) -> dict:
    normalized = _NON_TOKEN_RE.sub(" ", _text(text).lower())
    chars = list(_WS_RE.sub("", normalized))
    grams: dict[str, int] = {}
    for index in range(len(chars) - 1):
        gram = chars[index] + chars[index + 1]
        grams[gram] = grams.get(gram, 0) + 1
    for word in _WS_RE.split(normalized):
        if len(word) > 1:
            key = f"w:{word}"
            grams[key] = grams.get(key, 0) + 1
    return grams


def cosine(left: dict, right: dict) -> float:
    norm_left = sum(value * value for value in left.values())
    norm_right = sum(value * value for value in right.values())
    if not norm_left or not norm_right:
        return 0.0
    dot = 0.0
    for key, value in left.items():
        if key in right:
            dot += value * right[key]
    return dot / (math.sqrt(norm_left) * math.sqrt(norm_right))


def _idf(documents_tokens, term) -> float:
    if not documents_tokens:
        return 0.0
    df = sum(1 for tokens in documents_tokens if term in tokens)
    return math.log((len(documents_tokens) + 1) / (df + 1)) + 1


def tfidf_score(query_tokens, doc_tokens, documents_tokens) -> float:
    """TF-IDF 相似度：查询词在文档中的词频乘以逆文档频率。"""
    score = 0.0
    doc_len = sum(doc_tokens.values()) or 1
    for term, qf in query_tokens.items():
        tf = doc_tokens.get(term, 0) / doc_len
        idf = _idf(documents_tokens, term)
        score += qf * tf * idf
    return score


def bm25_score(query_tokens, doc_tokens, documents_tokens, *, k1=1.5, b=0.75) -> float:
    """BM25 (Okapi) 评分，用于案例相似度检索。"""
    if not documents_tokens:
        return 0.0
    avgdl = sum(sum(tokens.values()) for tokens in documents_tokens) / len(documents_tokens)
    doc_len = sum(doc_tokens.values())
    score = 0.0
    for term, qf in query_tokens.items():
        if term not in doc_tokens:
            continue
        f = doc_tokens[term]
        idf = _idf(documents_tokens, term)
        numerator = f * (k1 + 1)
        denominator = f + k1 * (1 - b + b * (doc_len / max(avgdl, 1)))
        score += qf * idf * (numerator / denominator)
    return score


class MemorySystem:
    def __init__(self, options=None, **kwargs) -> None:
        merged: dict = {}
        if isinstance(options, dict):
            merged.update(options)
        elif isinstance(options, (list, tuple)):
            merged["episodes"] = list(options)
        merged.update(kwargs)

        self.working: dict[str, list] = {}
        self.episodic: list[dict] = []
        semantic = _pick(merged, "semantic")
        self.semantic = semantic if semantic is not None else self.default_graph()
        self.max_working = _pick(merged, "maxWorking", "max_working", default=60)
        self.max_episodic = 200
        for episode in _pick(merged, "episodes", default=[]) or []:
            self.add_episode(episode)

    def default_graph(self) -> dict:
        return {
            "nodes": [
                {"id": "product:P-01", "label": "明前狮峰龙井", "type": "product"},
                {"id": "product:P-02", "label": "凤凰蜜兰单丛", "type": "product"},
                {"id": "product:P-05", "label": "春茶三味礼盒", "type": "product"},
                {"id": "rule:no-extreme", "label": "禁用极限词", "type": "rule"},
                {"id": "rule:price-floor", "label": "价格不得低于底价", "type": "rule"},
                {"id": "rule:health-claim", "label": "不得宣称功效", "type": "rule"},
                {"id": "script:story", "label": "故事型话术", "type": "script"},
                {"id": "script:param", "label": "参数型话术", "type": "script"},
                {"id": "script:compare", "label": "对比型话术", "type": "script"},
                {"id": "audience:night", "label": "夜间高客单人群", "type": "audience"},
                {"id": "audience:new", "label": "新客尝鲜人群", "type": "audience"},
                {"id": "case:night-story", "label": "夜间故事型成功案例", "type": "case"},
                {"id": "case:early-push", "label": "开场逼单翻车案例", "type": "case"},
            ],
            "edges": [
                {"from": "product:P-01", "to": "script:story", "relation": "适合"},
                {"from": "product:P-05", "to": "audience:new", "relation": "面向"},
                {"from": "product:P-02", "to": "script:param", "relation": "适合"},
                {"from": "script:compare", "to": "rule:no-extreme", "relation": "受限"},
                {"from": "script:story", "to": "audience:night", "relation": "匹配"},
                {"from": "audience:night", "to": "case:night-story", "relation": "证据"},
                {"from": "case:early-push", "to": "rule:price-floor", "relation": "教训"},
                {"from": "product:P-01", "to": "rule:price-floor", "relation": "约束"},
                {"from": "product:P-02", "to": "rule:health-claim", "relation": "约束"},
            ],
        }

    def push_working(self, agent_id, entry=None) -> list:
        record = {**(entry or {}), "at": now_ms()}
        bucket = self.working.get(agent_id)
        if bucket is None:
            bucket = []
        bucket.append(record)
        if len(bucket) > self.max_working:
            del bucket[: len(bucket) - self.max_working]
        self.working[agent_id] = bucket
        return bucket

    def get_working(self, agent_id, limit=8) -> list:
        bucket = list(self.working.get(agent_id) or [])
        keep = len(bucket) if limit is None else limit
        return bucket[-keep:][::-1]

    def add_episode(self, episode=None) -> dict:
        source = dict(episode or {})
        record = {
            "id": source.get("id") if source.get("id") is not None else f"EP-{len(self.episodic) + 1}",
            "createdAt": source.get("createdAt")
            if source.get("createdAt") is not None
            else _iso_now(),
        }
        record.update(source)
        record["_tokens"] = tokenize(
            f"{_text(source.get('title'))} {_text(source.get('text'))} "
            f"{' '.join(_text(tag) for tag in (source.get('tags') or []))}"
        )
        self.episodic.insert(0, record)
        if len(self.episodic) > self.max_episodic:
            self.episodic.pop()
        return record

    def recall(self, query, limit=3) -> list:
        tokens = tokenize(query)
        now = now_ms()
        hits = []
        for episode in self.episodic:
            semantic_score = cosine(tokens, episode.get("_tokens") or {})
            created = _epoch_ms(episode.get("createdAt"))
            if created is None:
                created = now
            if math.isnan(created):
                score = _NAN
            else:
                age_days = max(0.0, (now - created) / _DAY_MS)
                recency = 1 / (1 + age_days / 30)
                score = round_to(semantic_score * 0.82 + recency * 0.18, 4)
            if score > 0.03:
                item = self.public_episode(episode)
                item["score"] = score
                hits.append(item)
        hits.sort(key=lambda item: -item["score"])
        return hits[:limit]

    def public_episode(self, episode) -> dict:
        return {key: value for key, value in episode.items() if key != "_tokens"}

    def semantic_query(self, entity) -> dict:
        needle = _text(entity).lower()
        nodes = [
            node
            for node in self.semantic["nodes"]
            if needle in _text(node.get("label")).lower() or needle in _text(node.get("id")).lower()
        ]
        ids = {node.get("id") for node in nodes}
        edges = [
            edge for edge in self.semantic["edges"] if edge.get("from") in ids or edge.get("to") in ids
        ]
        return {"nodes": nodes, "edges": edges}

    def _doc_tokens_list(self):
        return [episode.get("_tokens") or {} for episode in self.episodic]

    def recall_bm25(self, query, limit=3) -> list:
        """BM25 检索：按 Okapi 评分召回历史案例。"""
        query_tokens = tokenize(query)
        documents = self._doc_tokens_list()
        hits = []
        for episode in self.episodic:
            score = bm25_score(query_tokens, episode.get("_tokens") or {}, documents)
            if score > 0:
                item = self.public_episode(episode)
                item["score"] = round_to(score, 6)
                item["method"] = "bm25"
                hits.append(item)
        hits.sort(key=lambda item: -item["score"])
        return hits[:limit]

    def recall_tfidf(self, query, limit=3) -> list:
        """TF-IDF 检索：按词频-逆文档频率召回历史案例。"""
        query_tokens = tokenize(query)
        documents = self._doc_tokens_list()
        hits = []
        for episode in self.episodic:
            score = tfidf_score(query_tokens, episode.get("_tokens") or {}, documents)
            if score > 0:
                item = self.public_episode(episode)
                item["score"] = round_to(score, 6)
                item["method"] = "tfidf"
                hits.append(item)
        hits.sort(key=lambda item: -item["score"])
        return hits[:limit]

    def recall_cases(self, query, limit=3) -> list:
        """历史案例相似度检索：融合 BM25、TF-IDF 与余弦（带时间衰减）。"""
        documents = self._doc_tokens_list()
        query_tokens = tokenize(query)
        now = now_ms()
        hits = {}
        for episode in self.episodic:
            tokens = episode.get("_tokens") or {}
            bm25 = bm25_score(query_tokens, tokens, documents)
            tfidf = tfidf_score(query_tokens, tokens, documents)
            semantic = cosine(query_tokens, tokens)
            created = _epoch_ms(episode.get("createdAt"))
            if created is None or math.isnan(created):
                recency = 1.0
            else:
                age_days = max(0.0, (now - created) / _DAY_MS)
                recency = 1 / (1 + age_days / 30)
            # 融合权重：BM25 0.45 + TF-IDF 0.25 + 余弦 0.20 + 时效 0.10
            fused = bm25 * 0.45 + tfidf * 0.25 + semantic * 0.20 + recency * 0.10
            if fused > 0.01:
                item = self.public_episode(episode)
                item["score"] = round_to(fused, 6)
                item["bm25"] = round_to(bm25, 6)
                item["tfidf"] = round_to(tfidf, 6)
                item["cosine"] = round_to(semantic, 6)
                item["method"] = "fused"
                hits[episode.get("id")] = item
        ranked = sorted(hits.values(), key=lambda item: -item["score"])
        return ranked[:limit]

    def snapshot(self) -> dict:
        return {
            "working": {
                agent_id: list(bucket)[-4:][::-1] for agent_id, bucket in self.working.items()
            },
            "episodicCount": len(self.episodic),
            "recentEpisodes": [self.public_episode(episode) for episode in self.episodic[:5]],
            "retrieval": ["cosine", "tfidf", "bm25", "fused-cases"],
            "graph": {
                "nodes": len(self.semantic["nodes"]),
                "edges": len(self.semantic["edges"]),
                "sample": self.semantic["nodes"][:7],
            },
        }
