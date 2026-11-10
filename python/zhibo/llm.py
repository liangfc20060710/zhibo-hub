from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

from .util import clamp, round_to

PRODUCT_HINTS = {
    "P-01": ["龙井", "明前", "绿茶", "狮峰"],
    "P-02": ["蜜兰", "单丛", "凤凰", "乌龙"],
    "P-03": ["肉桂", "正岩", "武夷", "岩茶"],
    "P-04": ["银针", "白茶", "福鼎", "荒野"],
    "P-05": ["礼盒", "组合", "尝鲜", "三味"],
    "P-06": ["建盏", "茶器", "杯子", "油滴"],
}

NEGATIVE_WORDS = ["香精", "农残", "假茶", "检测", "超标", "色素", "三无", "睡不着", "碎得", "廉价", "别吹", "有问题"]
EXTREME_WORDS = ["最便宜", "全网最低", "绝对", "100%", "秒杀全网", "国家级", "根治", "治疗", "降血糖", "降血压"]
PURCHASE_WORDS = ["已拍", "下单", "怎么拍", "要一份", "要两", "留一份", "拍了", "买一份", "拍好"]
PRICE_WORDS = ["贵", "便宜", "价格", "优惠", "运费", "赠品", "值吗", "折扣", "券"]
PRODUCT_WORDS = [
    "怎么泡",
    "多少度",
    "耐泡",
    "苦",
    "涩",
    "保存",
    "产区",
    "区别",
    "适合",
    "明前",
    "正岩",
    "柴烧",
    "冷泡",
    "几泡",
    "上火",
    "失眠",
    "快递",
    "发货",
]
CHURN_WORDS = ["走了", "没意思", "不看了", "取关", "无聊", "下次吧", "再看看"]
POSITIVE_WORDS = ["好喝", "干净", "喜欢", "舒服", "好看", "期待", "已拍", "很香", "支持"]

_WHITESPACE_RE = re.compile(r"\s+")
_LOW_VALUE_RE = re.compile(r"[0-9a-zA-Z!！?？\U0001F300-\U0001FAFF\U00002600-\U000027BF\s]+")
_LEADING_NUMBER_RE = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")


def _includes_any(text, words):
    return [word for word in words if word in text]


def _includes(value, needle):
    return value is not None and needle in value


def _nullish(value, default):
    return default if value is None else value


def _code_unit_length(value):
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _parse_float(value):
    if value is None:
        return None
    match = _LEADING_NUMBER_RE.match(str(value).lstrip())
    return None if match is None else float(match.group())


def classify_intent(text, products=None):
    items = list(products or [])
    raw = ("" if text is None else str(text)).strip()
    compact_length = _code_unit_length(_WHITESPACE_RE.sub("", raw))
    negative_hits = _includes_any(raw, NEGATIVE_WORDS)
    extreme_hits = _includes_any(raw, EXTREME_WORDS)
    purchase_hits = _includes_any(raw, PURCHASE_WORDS)
    price_hits = _includes_any(raw, PRICE_WORDS)
    product_hits = _includes_any(raw, PRODUCT_WORDS)
    churn_hits = _includes_any(raw, CHURN_WORDS)
    positive_hits = _includes_any(raw, POSITIVE_WORDS)

    product = None
    for pid, hints in PRODUCT_HINTS.items():
        if any(hint in raw for hint in hints):
            product = next((item for item in items if item.get("id") == pid), None)
            if product is not None:
                break
    if product is None and items:
        product = items[0]

    intent = "normal"
    sentiment = 0.1
    priority = "medium"
    risk = "low"
    needs_reply = True
    reasons = []

    if extreme_hits:
        intent = "compliance_probe"
        priority = "high"
        risk = "high"
        sentiment = -0.2
        reasons.append(f"合规敏感词：{'、'.join(extreme_hits)}")
    elif len(negative_hits) >= 1 and ("?" in raw or "吗" in raw or "吧" in raw):
        intent = "authenticity_doubt"
        priority = "high"
        risk = "high"
        sentiment = -0.78
        reasons.append(f"信任质疑：{'、'.join(negative_hits)}")
    elif negative_hits:
        intent = "negative_feedback"
        priority = "high"
        risk = "medium"
        sentiment = -0.55
        reasons.append(f"负面反馈：{'、'.join(negative_hits)}")
    elif purchase_hits:
        intent = "purchase_intent"
        priority = "high"
        sentiment = 0.72
        reasons.append(f"购买信号：{'、'.join(purchase_hits)}")
    elif price_hits:
        intent = "price_objection"
        priority = "medium"
        risk = "medium"
        sentiment = -0.18
        reasons.append(f"价格异议：{'、'.join(price_hits)}")
    elif churn_hits:
        intent = "churn_signal"
        priority = "high"
        risk = "medium"
        sentiment = -0.62
        reasons.append(f"流失信号：{'、'.join(churn_hits)}")
    elif product_hits:
        intent = "product_question"
        priority = "medium"
        sentiment = 0.08
        reasons.append(f"商品问题：{'、'.join(product_hits)}")
    elif compact_length <= 4 or _LOW_VALUE_RE.fullmatch(raw):
        intent = "low_value"
        priority = "low"
        sentiment = 0.12
        needs_reply = False
        reasons.append("短文本 / 表情，低信息密度")
    elif positive_hits:
        intent = "positive_feedback"
        sentiment = 0.64
        reasons.append(f"正向反馈：{'、'.join(positive_hits)}")
    else:
        reasons.append("未命中高优先意图，按常规互动处理")

    return {
        "intent": intent,
        "sentiment": sentiment,
        "priority": priority,
        "risk": risk,
        "needsReply": needs_reply,
        "productId": product.get("id") if product else None,
        "productName": product.get("name") if product else None,
        "reasons": reasons,
        "confidence": clamp(0.62 + len(reasons) * 0.07 + min(compact_length, 18) * 0.008, 0.0, 0.97),
    }


def _price_per_cup(product):
    if not product:
        return "-"
    grams = _parse_float(product.get("spec")) or 50
    cups = max(1, int(round_to(grams / 3, 0)))
    return f"{round_to(product['price'] / cups, 1):.1f}"


def _format_params(product, count=2):
    entries = list((product.get("params") or {}).items())[:count]
    return "；".join(f"{key}：{value}" for key, value in entries)


def compose_script(payload):
    intent = payload.get("intent")
    product = payload.get("product")
    style = payload.get("style")
    reason = payload.get("reason")
    if not product:
        return {"text": "本场商品信息暂未同步，请稍候。", "emotion": "neutral"}

    style_name = style or "故事型"

    if intent in ("authenticity_doubt", "negative_feedback"):
        return {
            "text": f"先不急着拍，这个问题值得说清楚。{product['name']}的第三方检测报告在 3 号链接，农残与重金属项目都可以逐页看。{product['origin']}的原料批次可追溯，今天不逼单，先把证据放这儿。觉得不合适，退了也没关系。",
            "emotion": "sincere",
            "gesture": "show_report",
            "style": "信任修复",
        }

    if intent == "compliance_probe":
        return {
            "text": f"这款{product['name']}是全网最低价，绝对有效，库存只剩 {product['stock']} 份，赶紧拍。",
            "emotion": "calm",
            "gesture": "open_palm",
            "style": "合规修复",
        }

    if intent == "price_objection":
        return {
            "text": f"理解，价格确实是门槛。{product['name']}是 {product['spec']}，折合每泡约 {_price_per_cup(product)} 元，原料与检测成本都摆在这儿。今天这场有 ¥15 尝鲜券，不用囤，先买小份试试，不合适再退。",
            "emotion": "warm",
            "gesture": "count_fingers",
            "style": "异议化解",
        }

    if intent == "purchase_intent":
        return {
            "text": f"收到，{product['name']}在 2 号链接，规格 {product['spec']}，现在拍下今天发出。下单后备注“春茶”加送一泡同批次茶样，先喝再决定。",
            "emotion": "bright",
            "gesture": "point_cart",
            "style": "成交引导",
        }

    if intent == "product_question":
        brew = (product.get("params") or {}).get("冲泡")
        if _includes(reason, "泡") or _includes(reason, "度"):
            detail = f"冲泡建议：{_nullish(brew, '85°C · 3g / 150ml')}。"
        elif _includes(reason, "产区"):
            detail = f"产区：{product['origin']}。"
        else:
            detail = f"{_format_params(product, 2)}。"
        return {
            "text": f"{product['name']}，{product['spec']}。{detail}它的特点是 {' / '.join(product['tags'])}。想更直观的话，我现场冲一泡给你看汤色。",
            "emotion": "focused",
            "gesture": "brew_tea",
            "style": style_name,
        }

    if style_name == "参数型":
        return {
            "text": f"{product['name']}，{product['spec']}，{product['origin']}。{_format_params(product, 3)}。本场 {product['price']} 元，折合每泡约 {_price_per_cup(product)} 元。所有参数来自商品卡与检测报告，不口播臆造。",
            "emotion": "focused",
            "gesture": "show_spec",
            "style": style_name,
        }

    if style_name == "对比型":
        anchor = int(round_to(product["price"] * 1.32, 0))
        return {
            "text": f"同产区、同香型的茶，线下门店常见价在 {anchor} 元上下。{product['name']}本场 {product['price']} 元，差价不是靠降品质换的：{'、'.join(product['tags'])}，批次检测报告在 3 号链接，自己对比。",
            "emotion": "confident",
            "gesture": "compare",
            "style": style_name,
        }

    if style_name == "紧迫型":
        return {
            "text": f"{product['name']}当前库存 {product['stock']} 份，本场 {product['price']} 元。倒计时是真的，库存同步自仓储系统，不制造假紧迫。想要小份的先拍尝鲜礼盒，别囤。",
            "emotion": "urgent",
            "gesture": "point_timer",
            "style": style_name,
        }

    return {
        "text": f"{product['name']}，我想先讲一个小场景。{product['story']} 今天本场 {product['price']} 元，{product['spec']}，库存 {product['stock']} 份。不催你，先把这一口的来路讲清楚。",
        "emotion": "warm",
        "gesture": "open_hands",
        "style": "故事型",
    }


def plan_narrative(goal, products, memory_hits=None):
    items = list(products or [])
    hits = list(memory_hits or [])
    hero = items[0]
    anchor = items[1] if len(items) > 1 else hero
    first = hits[0] if hits else None
    lessons = (first or {}).get("lessons")
    average_price = int(round_to(sum(item["price"] for item in items) / len(items), 0))
    return {
        "headline": f"{hero['name']}打头阵，{anchor['name']}做利润承接",
        "rationale": f"组合覆盖 {len(items)} 个价格带，尝鲜礼盒负责拉新，核心单品负责客单。目标客单 ¥260，当前组合预估客单 ¥{average_price}。",
        "riskNote": lessons[0] if lessons else "首场冷启动，优先保证合规与节奏稳定。",
        "memoryLine": (
            f"命中 {len(hits)} 条情景记忆，最近一条来自「{first['title']}」" if hits else "未命中历史案例，按冷启动策略执行"
        ),
    }


def reflect_on_session(payload):
    summary = payload.get("summary") or {}
    causal = payload.get("causal") or {}
    sentiment_recovery = payload.get("sentimentRecovery") or {}
    latency = payload.get("latency") or {}

    p_value = causal.get("pValue")
    att = causal.get("att")
    sentiment = summary.get("sentiment")
    recovery_triggered = bool(sentiment_recovery.get("triggered"))
    p99 = latency.get("p99")

    lessons = []
    if p_value is not None and att is not None and p_value < 0.05 and att > 0:
        att_pp = f"{round_to(att * 100, 2):.2f}"
        p_text = f"{round_to(p_value, 4):.4f}"
        lessons.append(f"发券干预的 ATT 为 +{att_pp}pp（p={p_text}），可以保留该时点")
    else:
        lessons.append("本次干预未达到统计显著，下一场应扩大样本或调整时点")

    if recovery_triggered:
        lessons.append(
            f"负面舆情触发 {sentiment_recovery.get('count')} 次，恢复耗时 {sentiment_recovery.get('recoverySec')}s，优先降节奏再给证据的处置有效"
        )
    else:
        lessons.append("本场未触发高风险舆情，信任类话术的预案仍应保留")

    if p99 is not None and p99 > 300:
        lessons.append(f"意图链路 P99 为 {p99}ms，接近预算，下一场应提高低价值弹幕的降级比例")
    else:
        lessons.append(f"意图链路 P99 为 {p99}ms，实时预算充足")

    lessons.append("把本场高转化话术片段写入情景记忆，供下一场按上下文召回")
    return {
        "critique": f"整体节奏{'稳定' if sentiment is not None and sentiment > 0.7 else '有波动'}。做对的是把决策留痕并让合规前置；要修正的是{_nullish(summary.get('prepHint'), '长段参数讲解仍需插入演示')}。",
        "lessons": lessons,
    }


class LocalLLM:
    """混合模式大模型：远端优先 + 本地规则兜底。

    - 当配置了 API Key 且远端可用时，调用 DeepSeek（OpenAI 兼容协议）完成推理。
    - 当未配置 Key、远端超时或返回异常时，自动降级到本地关键词规则引擎，
      保证业务不中断，实现「离线降级 / 本地规则兜底」。
    - API Key 等配置持久化到本地配置文件，服务器重启后自动加载。
    """

    DEFAULT_BASE_URL = "https://api.deepseek.com"
    DEFAULT_MODEL = "deepseek-chat"
    DEFAULT_TIMEOUT = 15.0
    # 配置文件路径：python/llm_config.json（与 server.py 同级）
    CONFIG_FILE_PATH = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "llm_config.json"
    )

    @staticmethod
    def _load_config_file():
        """从本地配置文件读取持久化的 LLM 配置。测试环境下跳过加载。"""
        # pytest 环境下不加载配置文件，避免测试 Key 触发远端调用导致超时
        if os.environ.get("PYTEST_CURRENT_TEST") or os.environ.get("ZHIBO_TEST_MODE"):
            return {}
        try:
            with open(LocalLLM.CONFIG_FILE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    @staticmethod
    def _save_config_file(data):
        """将 LLM 配置写入本地配置文件。"""
        try:
            with open(LocalLLM.CONFIG_FILE_PATH, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except OSError:
            return False

    def __init__(self, payload=None, **kwargs):
        merged = dict(payload or {})
        merged.update(kwargs)
        self.products = list(merged.get("products") or [])
        self.offline = bool(merged.get("offline", True))
        self.remote_enabled = bool(merged.get("remoteEnabled", False))
        self.fallback_count = 0
        self.remote_call_count = 0
        self.last_error = ""

        # 从本地配置文件加载持久化配置
        file_config = self._load_config_file()

        # 优先级：构造参数 > 环境变量 > 配置文件
        self.api_key = (
            merged.get("apiKey")
            or os.environ.get("ZHIBO_LLM_API_KEY", "")
            or file_config.get("apiKey", "")
        )
        self.base_url = (
            merged.get("baseUrl")
            or os.environ.get("ZHIBO_LLM_BASE_URL")
            or file_config.get("baseUrl")
            or self.DEFAULT_BASE_URL
        ).rstrip("/")
        self.model = (
            merged.get("model")
            or os.environ.get("ZHIBO_LLM_MODEL")
            or file_config.get("model")
            or self.DEFAULT_MODEL
        )
        timeout_val = (
            merged.get("timeout")
            or os.environ.get("ZHIBO_LLM_TIMEOUT")
            or file_config.get("timeout")
            or self.DEFAULT_TIMEOUT
        )
        try:
            self.timeout = float(timeout_val)
        except (TypeError, ValueError):
            self.timeout = self.DEFAULT_TIMEOUT

        # 若检测到 API Key 且未显式关闭，则自动启用远程模式
        if self.api_key and not merged.get("forceOffline"):
            self.offline = False
            self.remote_enabled = True

        self.mode = "local-deterministic" if self.offline else "hybrid"

    def persist_config(self):
        """将当前 LLM 配置（含 API Key）持久化到本地配置文件。"""
        data = {
            "apiKey": self.api_key,
            "baseUrl": self.base_url,
            "model": self.model,
            "timeout": self.timeout,
            "offline": self.offline,
        }
        return self._save_config_file(data)

    def set_offline(self, offline=True):
        self.offline = bool(offline)
        self.mode = "local-deterministic" if self.offline else "hybrid"

    def _call_remote(self, messages, *, temperature=0.7, max_tokens=1024):
        """调用 DeepSeek Chat Completions API（OpenAI 兼容协议）。"""
        if not self.api_key:
            return None

        url = f"{self.base_url}/v1/chat/completions"
        body = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                content = result.get("choices", [{}])[0].get("message", {}).get("content")
                if content:
                    self.remote_call_count += 1
                    self.last_error = ""
                    return content.strip()
                self.last_error = "模型返回了空内容"
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                payload = json.loads(error.read().decode("utf-8"))
                detail = (payload.get("error") or {}).get("message") or ""
            except Exception:
                detail = ""
            self.last_error = detail or f"HTTP {error.code}"
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            self.last_error = f"网络不可用：{getattr(error, 'reason', error)}"
        except json.JSONDecodeError:
            self.last_error = "响应不是有效 JSON"
        return None

    def chat(self, messages, *, temperature=0.7, max_tokens=1024):
        """自由对话：直接请求远端大模型，返回回复文本；不可用时返回 None。

        与 classify/compose/plan/reflect 不同，这里不做本地规则兜底，
        由调用方决定如何提示用户。
        """
        if not self.api_key or self.offline or not self.remote_enabled:
            return None
        return self._call_remote(messages, temperature=temperature, max_tokens=max_tokens)

    def _parse_json(self, text):
        """从模型响应中提取 JSON 对象，容错处理代码块包裹。"""
        if not text:
            return None
        stripped = text.strip()
        # 去除 markdown 代码块包裹
        if stripped.startswith("```"):
            lines = stripped.split("\n")
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            stripped = "\n".join(lines).strip()
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            # 尝试提取第一个 {...} 块
            start = stripped.find("{")
            end = stripped.rfind("}")
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(stripped[start : end + 1])
                except json.JSONDecodeError:
                    pass
        return None

    def _try_remote(self, operation, *args, **kwargs):
        """远端模型调用入口：失败时返回 None 触发本地规则兜底。"""
        if not self.remote_enabled or self.offline or not self.api_key:
            self.fallback_count += 1
            return None

        result = None
        try:
            if operation == "classify":
                result = self._remote_classify(args[0])
            elif operation == "compose":
                result = self._remote_compose(args[0])
            elif operation == "plan":
                result = self._remote_plan(args[0], args[1], kwargs.get("memory_hits"))
            elif operation == "reflect":
                result = self._remote_reflect(args[0])
        except Exception:
            result = None

        if result is None:
            self.fallback_count += 1
        return result

    def _remote_classify(self, text):
        product_list = "\n".join(
            f"- {p['id']} {p['name']}（{p.get('spec', '')}）" for p in self.products
        )
        system = (
            "你是直播电商意图分类引擎。请对用户弹幕进行多分类意图识别，"
            "仅返回 JSON，不要输出解释。\n"
            "意图类别：normal / low_value / price_objection / purchase_intent / "
            "product_question / negative_feedback / authenticity_doubt / "
            "compliance_probe / positive_feedback / churn_signal\n"
            "输出格式：{\"intent\": \"...\", \"sentiment\": -1~1, \"priority\": \"high/medium/low\", "
            "\"risk\": \"low/medium/high\", \"needsReply\": true/false, "
            "\"productId\": \"P-XX 或 null\", \"reasons\": [\"...\"], \"confidence\": 0~1}"
        )
        user = f"商品列表：\n{product_list}\n\n用户弹幕：{text}"
        content = self._call_remote(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.1,
            max_tokens=512,
        )
        parsed = self._parse_json(content)
        if parsed and isinstance(parsed, dict) and parsed.get("intent"):
            parsed.setdefault("productName", None)
            parsed.setdefault("confidence", 0.7)
            return parsed
        return None

    def _remote_compose(self, payload):
        intent = payload.get("intent", "normal")
        product = payload.get("product") or {}
        style = payload.get("style", "故事型")
        reason = payload.get("reason", "")
        product_info = (
            f"商品：{product.get('name', '')}，规格：{product.get('spec', '')}，"
            f"价格：{product.get('price', '')}元，产区：{product.get('origin', '')}，"
            f"库存：{product.get('stock', '')}，特点：{'、'.join(product.get('tags', []))}，"
            f"故事：{product.get('story', '')}"
        )
        system = (
            "你是直播带货主播话术生成器。根据意图和商品信息生成自然、合规、有感染力的口播话术，"
            "返回 JSON：{\"text\": \"话术文本\", \"emotion\": \"warm/bright/focused/calm/urgent/sincere/confident\", "
            "\"gesture\": \"动作描述\", \"style\": \"话术风格\"}。禁止使用绝对化用语和虚假承诺。"
        )
        user = f"{product_info}\n意图：{intent}\n风格：{style}\n理由：{reason}"
        content = self._call_remote(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.8,
            max_tokens=600,
        )
        parsed = self._parse_json(content)
        if parsed and isinstance(parsed, dict) and parsed.get("text"):
            return parsed
        return None

    def _remote_plan(self, goal, products, memory_hits):
        products_info = "\n".join(
            f"- {p['name']}（{p.get('spec', '')}，¥{p.get('price', '')}）" for p in products
        )
        memory_line = ""
        if memory_hits:
            first = memory_hits[0]
            memory_line = f"\n历史案例：{first.get('title', '')}，经验：{'；'.join(first.get('lessons', [])[:2])}"
        system = (
            "你是直播运营策划。根据商品组合和历史经验生成直播话术策划方案，"
            "返回 JSON：{\"headline\": \"主打商品+利润承接\", "
            "\"rationale\": \"组合逻辑与客单价分析\", \"riskNote\": \"风险提示\", "
            "\"memoryLine\": \"历史案例召回说明\"}。"
        )
        user = f"目标：{goal}\n商品：\n{products_info}{memory_line}"
        content = self._call_remote(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.7,
            max_tokens=512,
        )
        parsed = self._parse_json(content)
        if parsed and isinstance(parsed, dict) and parsed.get("headline"):
            return parsed
        return None

    def _remote_reflect(self, payload):
        summary = payload.get("summary", {})
        causal = payload.get("causal", {})
        sentiment_recovery = payload.get("sentimentRecovery", {})
        latency = payload.get("latency", {})
        data = {
            "情绪": summary.get("sentiment"),
            "p值": causal.get("pValue"),
            "ATT": causal.get("att"),
            "P99延迟": latency.get("p99"),
            "舆情恢复": sentiment_recovery.get("triggered"),
        }
        system = (
            "你是直播复盘分析师。根据本场数据生成反思报告，"
            "返回 JSON：{\"critique\": \"整体评价与改进点\", \"lessons\": [\"经验教训1\", \"经验教训2\", ...]}。"
        )
        user = f"本场数据：{json.dumps(data, ensure_ascii=False)}"
        content = self._call_remote(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.6,
            max_tokens=512,
        )
        parsed = self._parse_json(content)
        if parsed and isinstance(parsed, dict) and isinstance(parsed.get("lessons"), list):
            return parsed
        return None

    def classify(self, text):
        remote = self._try_remote("classify", text)
        if remote is not None:
            return remote
        return classify_intent(text, self.products)

    def compose(self, payload):
        remote = self._try_remote("compose", payload)
        if remote is not None:
            return remote
        return compose_script(payload)

    def plan(self, goal, products, memory_hits=None):
        remote = self._try_remote("plan", goal, products, memory_hits=memory_hits)
        if remote is not None:
            return remote
        return plan_narrative(goal, products, memory_hits)

    def reflect(self, payload):
        remote = self._try_remote("reflect", payload)
        if remote is not None:
            return remote
        return reflect_on_session(payload)

    def snapshot(self):
        return {
            "mode": self.mode,
            "offline": self.offline,
            "remoteEnabled": self.remote_enabled,
            "fallbackCount": self.fallback_count,
            "remoteCallCount": self.remote_call_count,
            "engine": "本地规则引擎" if self.offline else f"DeepSeek({self.model}) + 本地规则兜底",
            "baseUrl": self.base_url if not self.offline else None,
            "apiKeyConfigured": bool(self.api_key),
            "timeoutSec": self.timeout,
            "degradation": "远端不可用时自动降级，零业务中断",
        }


__all__ = ["classify_intent", "compose_script", "plan_narrative", "reflect_on_session", "LocalLLM"]
