"""A small BM25 search index over the bundled spaceflight-history corpus."""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from importlib import resources

_TOKEN = re.compile(r"[a-z0-9]+")
# fmt: off
_STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from",
        "has", "have", "he", "her", "his", "how", "in", "is", "it", "its", "of", "on", "or",
        "she", "that", "the", "their", "them", "they", "this", "to", "was", "were", "what",
        "when", "which", "who", "with",
    }
)
# fmt: on


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(text.lower()) if t not in _STOPWORDS]


@dataclass(frozen=True)
class Document:
    doc_id: str
    title: str
    body: str


@dataclass(frozen=True)
class SearchHit:
    doc_id: str
    title: str
    score: float
    snippet: str


class Corpus:
    """Okapi BM25 over whole documents; the snippet is the best-matching paragraph."""

    def __init__(self, documents: list[Document], *, k1: float = 1.5, b: float = 0.75) -> None:
        if not documents:
            raise ValueError("corpus is empty")
        self.documents = documents
        self._k1 = k1
        self._b = b
        # Titles are counted twice so they weigh more than body text.
        self._term_freqs = [Counter(tokenize(f"{d.title} {d.title} {d.body}")) for d in documents]
        self._lengths = [sum(tf.values()) for tf in self._term_freqs]
        self._avg_length = sum(self._lengths) / len(documents)
        doc_freq = Counter(term for tf in self._term_freqs for term in tf)
        n = len(documents)
        self._idf = {t: math.log(1 + (n - df + 0.5) / (df + 0.5)) for t, df in doc_freq.items()}

    @classmethod
    def bundled(cls) -> Corpus:
        root = resources.files("research_agent") / "corpus"
        documents = []
        for entry in sorted(root.iterdir(), key=lambda e: e.name):
            if not entry.name.endswith(".md"):
                continue
            title_line, _, body = entry.read_text(encoding="utf-8").partition("\n")
            documents.append(
                Document(
                    entry.name.removesuffix(".md"), title_line.lstrip("# ").strip(), body.strip()
                )
            )
        return cls(documents)

    def search(self, query: str, limit: int = 3) -> list[SearchHit]:
        terms = tokenize(query)
        scored = []
        for doc, tf, length in zip(self.documents, self._term_freqs, self._lengths, strict=True):
            score = sum(self._term_score(term, tf, length) for term in terms)
            if score > 0:
                scored.append((score, doc))
        scored.sort(key=lambda pair: (-pair[0], pair[1].doc_id))
        return [
            SearchHit(doc.doc_id, doc.title, round(score, 3), _best_paragraph(doc.body, terms))
            for score, doc in scored[:limit]
        ]

    def _term_score(self, term: str, tf: Counter[str], length: int) -> float:
        freq = tf.get(term, 0)
        if not freq:
            return 0.0
        norm = self._k1 * (1 - self._b + self._b * length / self._avg_length)
        return self._idf[term] * freq * (self._k1 + 1) / (freq + norm)


def _best_paragraph(body: str, terms: list[str]) -> str:
    paragraphs = [p.strip() for p in body.split("\n\n") if p.strip()]
    wanted = set(terms)
    return max(paragraphs, key=lambda p: len(wanted.intersection(tokenize(p))))
