import { useState, useEffect, useCallback } from "react";
import api, { getToken } from "../api/apiClient";
import {
  listImagingDatasets,
  listImagingDatasetSamples,
  runImagingDatasetBenchmark,
  analyzeImagingDatasetSample,
  importImagingDatasetSample,
  getImagingDatasetThumbnailUrl,
} from "../api/apiClient";
import { Tag } from "./ui";

function AuthenticatedImage({ src, alt, className }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError(false);

    const apiPath = src.startsWith("/api") ? src.slice(4) : src;
    api
      .get(apiPath, { responseType: "blob", signal: controller.signal })
      .then((res) => {
        if (!active) return;
        const url = URL.createObjectURL(res.data);
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (active && err.code !== "ERR_CANCELED") {
          setError(true);
          setLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);

  if (error) {
    return (
      <div className={`flex items-center justify-center bg-[#17251d]/10 text-slate-400 text-[11px] ${className}`}>
        Unavailable
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center bg-[#17251d]/5 animate-pulse text-slate-400 text-[11px] ${className}`}>
        Loading…
      </div>
    );
  }

  return <img src={blobUrl} alt={alt || ""} className={className} />;
}

export default function ImagingDatasets() {
  const [datasets, setDatasets] = useState([]);
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [error, setError] = useState(null);

  const [activeDatasetName, setActiveDatasetName] = useState(null);
  const [selectedClass, setSelectedClass] = useState("");
  const [samples, setSamples] = useState([]);
  const [loadingSamples, setLoadingSamples] = useState(false);

  const [targetPatientId, setTargetPatientId] = useState("DEMO-DATASET");
  const [importingId, setImportingId] = useState(null);
  const [importStatus, setImportStatus] = useState({});

  const [analyzingId, setAnalyzingId] = useState(null);
  const [analysisResults, setAnalysisResults] = useState({});

  const [benchmarkResult, setBenchmarkResult] = useState(null);
  const [runningBenchmark, setRunningBenchmark] = useState(false);
  const [benchmarkLimit, setBenchmarkLimit] = useState(0);
  const [benchmarkSplit, setBenchmarkSplit] = useState("test");
  const [selectedModel, setSelectedModel] = useState("");

  // Load datasets on mount
  useEffect(() => {
    let active = true;
    setLoadingDatasets(true);
    listImagingDatasets()
      .then((data) => {
        if (!active) return;
        const list = data.datasets || [];
        setDatasets(list);
        if (list.length > 0) {
          setActiveDatasetName(list[0].name);
          if (list[0].compatibleModels?.length > 0) {
            setSelectedModel(list[0].compatibleModels[0]);
          }
        }
        setLoadingDatasets(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err.response?.data?.error || "Failed to load imaging datasets");
        setLoadingDatasets(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const activeDataset = datasets.find((d) => d.name === activeDatasetName) || null;

  // Update selected model & load cached benchmark when active dataset changes
  useEffect(() => {
    if (activeDataset?.compatibleModels?.length > 0) {
      setSelectedModel(activeDataset.compatibleModels[0]);
    }
    setSelectedClass("");
    setBenchmarkResult(null);
    setAnalysisResults({});
    setImportStatus({});

    if (activeDatasetName) {
      runImagingDatasetBenchmark(activeDatasetName, { split: "test" })
        .then((data) => setBenchmarkResult(data))
        .catch(() => {});
    }
  }, [activeDatasetName]);

  // Load samples
  const fetchSamples = useCallback(async (datasetName, className) => {
    if (!datasetName) return;
    setLoadingSamples(true);
    try {
      const res = await listImagingDatasetSamples(datasetName, { className, limit: 60 });
      setSamples(res.samples || []);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to fetch dataset samples");
    } finally {
      setLoadingSamples(false);
    }
  }, []);

  useEffect(() => {
    if (activeDatasetName) {
      fetchSamples(activeDatasetName, selectedClass);
    }
  }, [activeDatasetName, selectedClass, fetchSamples]);

  // Analyze single sample
  const handleAnalyzeSample = async (sample) => {
    if (!activeDatasetName || analyzingId) return;
    setAnalyzingId(sample.id);
    try {
      const res = await analyzeImagingDatasetSample(activeDatasetName, sample.id, {
        model: selectedModel,
      });
      setAnalysisResults((prev) => ({
        ...prev,
        [sample.id]: res,
      }));
    } catch (err) {
      setAnalysisResults((prev) => ({
        ...prev,
        [sample.id]: {
          error: err.response?.data?.error || "Analysis failed",
        },
      }));
    } finally {
      setAnalyzingId(null);
    }
  };

  // Import to demo patient
  const handleImportSample = async (sample) => {
    const pid = targetPatientId.trim();
    if (!pid || !pid.startsWith("DEMO-")) {
      setImportStatus((prev) => ({
        ...prev,
        [sample.id]: { error: "Patient ID must start with DEMO-" },
      }));
      return;
    }
    setImportingId(sample.id);
    try {
      const res = await importImagingDatasetSample(activeDatasetName, sample.id, pid);
      setImportStatus((prev) => ({
        ...prev,
        [sample.id]: {
          success: true,
          patientId: pid,
          mediaId: res._id || res.gridfs_id,
        },
      }));
    } catch (err) {
      setImportStatus((prev) => ({
        ...prev,
        [sample.id]: {
          error: err.response?.data?.error || "Import failed",
        },
      }));
    } finally {
      setImportingId(null);
    }
  };

  // Run benchmark
  const handleRunBenchmark = async () => {
    if (!activeDatasetName || runningBenchmark) return;
    setRunningBenchmark(true);
    setError(null);
    try {
      const res = await runImagingDatasetBenchmark(activeDatasetName, {
        model: selectedModel,
        limit: benchmarkLimit > 0 ? benchmarkLimit : undefined,
        split: benchmarkSplit,
      });
      setBenchmarkResult(res);
    } catch (err) {
      setError(err.response?.data?.error || "Benchmark computation failed");
    } finally {
      setRunningBenchmark(false);
    }
  };

  if (loadingDatasets) {
    return (
      <div className="p-8 text-center text-slate-500 font-mono text-sm">
        Loading imaging datasets library…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div role="alert" className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">
          {error}
        </div>
      )}

      {/* ── Dataset Cards ── */}
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Available Datasets</span>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {datasets.map((ds) => {
            const isSelected = ds.name === activeDatasetName;
            return (
              <div
                key={ds.name}
                onClick={() => setActiveDatasetName(ds.name)}
                className={`cursor-pointer rounded-xl p-4 transition border ${
                  isSelected
                    ? "bg-[#fbfaf7] border-ink shadow-sm"
                    : "bg-[#f4eee7]/50 border-line hover:border-ink/50"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-serif text-lg text-ink font-medium leading-snug">
                      {ds.displayName || ds.name}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <Tag tone="low">{ds.modality}</Tag>
                      <Tag tone="normal">{ds.license}</Tag>
                      {ds.counts?.total && (
                        <span className="text-[11px] font-mono text-slate-500">
                          {ds.counts.total} images
                        </span>
                      )}
                    </div>
                  </div>
                  {isSelected && (
                    <span className="text-[10px] uppercase font-mono px-2 py-0.5 bg-ink text-paper rounded">
                      Selected
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-600 mt-2.5 line-clamp-2">
                  <span className="font-semibold text-slate-700">Citation:</span> {ds.citation}
                </p>

                <div className="flex flex-wrap gap-1 mt-3">
                  {ds.classes?.map((c) => (
                    <span
                      key={c}
                      className="text-[11px] font-mono bg-paper border border-line px-1.5 py-0.5 rounded text-slate-600"
                    >
                      {c} {ds.counts?.[c] ? `(${ds.counts[c]})` : ""}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {activeDataset && (
        <>
          {/* ── Benchmark Section ── */}
          <div className="bg-[#fbfaf7] border border-line rounded-xl p-5 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-line">
              <div>
                <span className="eyebrow">Model Performance & Evaluation</span>
                <h4 className="font-serif text-lg text-ink">
                  Benchmark · {activeDataset.displayName || activeDataset.name}
                </h4>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {activeDataset.compatibleModels?.length > 1 && (
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="h-8 text-xs bg-paper border border-line rounded px-2 text-ink font-mono"
                  >
                    {activeDataset.compatibleModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}

                <div className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span>Split:</span>
                  <select
                    value={benchmarkSplit}
                    onChange={(e) => setBenchmarkSplit(e.target.value)}
                    className="h-8 text-xs bg-paper border border-line rounded px-2 text-ink font-mono"
                  >
                    <option value="test">Official Test</option>
                    <option value="validation">Validation</option>
                    <option value="train">Train</option>
                    <option value="all">All</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span>Samples:</span>
                  <select
                    value={benchmarkLimit}
                    onChange={(e) => setBenchmarkLimit(Number(e.target.value))}
                    className="h-8 text-xs bg-paper border border-line rounded px-2 text-ink font-mono"
                  >
                    <option value={0}>Full Split</option>
                    <option value={10}>10 / class</option>
                    <option value={30}>30 / class</option>
                    <option value={60}>60 / class</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleRunBenchmark}
                  disabled={runningBenchmark}
                  className="btn-primary h-8 text-xs px-3"
                >
                  {runningBenchmark ? "Evaluating…" : "Run benchmark"}
                </button>
              </div>
            </div>

            {/* Benchmark Results Display */}
            {benchmarkResult ? (
              <div className="flex flex-col gap-5">
                {/* Summary Metrics Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <div className="bg-paper p-3 rounded-lg border border-line flex flex-col">
                    <span className="text-[10px] font-mono uppercase text-slate-500">Accuracy</span>
                    <span className="font-serif text-2xl font-semibold text-ink mt-1">
                      {(benchmarkResult.metrics?.accuracy * 100).toFixed(1)}%
                    </span>
                    <span className="text-[10px] text-slate-400 mt-auto">Overall correct</span>
                  </div>

                  <div className="bg-paper p-3 rounded-lg border border-line flex flex-col">
                    <span className="text-[10px] font-mono uppercase text-slate-500">Macro F1</span>
                    <span className="font-serif text-2xl font-semibold text-ink mt-1">
                      {benchmarkResult.metrics?.macro_f1?.toFixed(3) ?? "—"}
                    </span>
                    <span className="text-[10px] text-slate-400 mt-auto">Balanced measure</span>
                  </div>

                  <div className="bg-paper p-3 rounded-lg border border-line flex flex-col">
                    <span className="text-[10px] font-mono uppercase text-slate-500">AUROC</span>
                    <span className="font-serif text-2xl font-semibold text-ink mt-1">
                      {benchmarkResult.metrics?.auroc != null
                        ? benchmarkResult.metrics.auroc.toFixed(3)
                        : "N/A"}
                    </span>
                    <span className="text-[10px] text-slate-400 mt-auto">Discrimination power</span>
                  </div>

                  <div className="bg-paper p-3 rounded-lg border border-line flex flex-col">
                    <span className="text-[10px] font-mono uppercase text-slate-500">Sample Size</span>
                    <span className="font-serif text-2xl font-semibold text-ink mt-1">
                      {benchmarkResult.n}
                    </span>
                    <span className="text-[10px] text-slate-400 mt-auto">
                      Evaluated images
                    </span>
                  </div>

                  <div className="bg-paper p-3 rounded-lg border border-line flex flex-col">
                    <span className="text-[10px] font-mono uppercase text-slate-500">Runtime</span>
                    <span className="font-serif text-2xl font-semibold text-ink mt-1">
                      {benchmarkResult.runtime_seconds != null
                        ? `${benchmarkResult.runtime_seconds.toFixed(1)}s`
                        : "—"}
                    </span>
                    <span className="text-[10px] text-slate-400 mt-auto">
                      {benchmarkResult.cached ? "Cached on disk" : "Computed"}
                    </span>
                  </div>
                </div>

                {/* Per-Class Table & Confusion Matrix Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  {/* Per-Class Performance Table */}
                  <div className="bg-paper rounded-lg border border-line p-3">
                    <span className="eyebrow block mb-2">Class Breakdown</span>
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-line text-slate-500 font-mono text-[10px] uppercase">
                          <th className="py-1.5 font-medium">Class</th>
                          <th className="py-1.5 font-medium">Precision</th>
                          <th className="py-1.5 font-medium">Recall</th>
                          <th className="py-1.5 font-medium">F1-Score</th>
                          <th className="py-1.5 font-medium text-right">Support</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(benchmarkResult.metrics?.per_class || {}).map(
                          ([cls, stats]) => (
                            <tr key={cls} className="border-b border-line/50 hover:bg-sunken/40">
                              <td className="py-2 font-medium text-slate-800">{cls}</td>
                              <td className="py-2 font-mono text-slate-600">
                                {stats.precision != null ? stats.precision.toFixed(3) : "—"}
                              </td>
                              <td className="py-2 font-mono text-slate-600">
                                {stats.recall != null ? stats.recall.toFixed(3) : "—"}
                              </td>
                              <td className="py-2 font-mono font-semibold text-ink">
                                {stats.f1_score != null ? stats.f1_score.toFixed(3) : "—"}
                              </td>
                              <td className="py-2 font-mono text-right text-slate-500">
                                {stats.support}
                              </td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Confusion Matrix */}
                  <div className="bg-paper rounded-lg border border-line p-3 flex flex-col">
                    <span className="eyebrow block mb-2">Confusion Matrix</span>
                    <div className="overflow-x-auto my-auto">
                      <table className="w-full text-center text-xs">
                        <thead>
                          <tr>
                            <th className="p-1 text-[10px] font-mono text-slate-400">Actual \ Pred</th>
                            {benchmarkResult.confusion_matrix?.classes?.map((c) => (
                              <th key={c} className="p-1 font-mono text-[10px] text-slate-700 truncate max-w-[80px]">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {benchmarkResult.confusion_matrix?.matrix?.map((row, rIdx) => {
                            const actualClass = benchmarkResult.confusion_matrix.classes[rIdx];
                            return (
                              <tr key={actualClass}>
                                <td className="p-1 text-left font-mono text-[10px] text-slate-700 font-medium">
                                  {actualClass}
                                </td>
                                {row.map((cell, cIdx) => {
                                  const isDiagonal = rIdx === cIdx;
                                  return (
                                    <td
                                      key={cIdx}
                                      className={`p-2 font-mono font-medium rounded ${
                                        isDiagonal
                                          ? "bg-risk-low/20 text-green-900 font-semibold"
                                          : cell > 0
                                          ? "bg-risk-high/15 text-orange-900"
                                          : "text-slate-400"
                                      }`}
                                    >
                                      {cell}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-slate-500">
                Click <span className="font-semibold text-slate-700">Run benchmark</span> to evaluate{" "}
                <span className="font-mono">{selectedModel || "the model"}</span> across the dataset and compute accuracy, AUROC, F1-scores, and confusion matrix.
              </div>
            )}
          </div>

          {/* ── Sample Grid Section ── */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="eyebrow">Sample Explorer</span>
                <h4 className="font-serif text-lg text-ink">
                  Filterable Samples ({samples.length})
                </h4>
              </div>

              {/* Patient ID target for demo import */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-600">Import Target:</span>
                <input
                  type="text"
                  value={targetPatientId}
                  onChange={(e) => setTargetPatientId(e.target.value)}
                  placeholder="DEMO-..."
                  className="h-8 font-mono text-xs px-2 bg-paper border border-line rounded w-36"
                />
              </div>
            </div>

            {/* Class Filter Tabs */}
            <div className="flex flex-wrap gap-1.5 border-b border-line pb-2.5">
              <button
                type="button"
                onClick={() => setSelectedClass("")}
                className={`text-xs px-3 py-1 rounded-full border transition ${
                  selectedClass === ""
                    ? "bg-ink text-paper border-ink"
                    : "bg-paper text-slate-600 border-line hover:border-slate-400"
                }`}
              >
                All Classes ({activeDataset.counts?.total || samples.length})
              </button>
              {activeDataset.classes?.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setSelectedClass(c)}
                  className={`text-xs px-3 py-1 rounded-full border transition ${
                    selectedClass === c
                      ? "bg-ink text-paper border-ink"
                      : "bg-paper text-slate-600 border-line hover:border-slate-400"
                  }`}
                >
                  {c} {activeDataset.counts?.[c] ? `(${activeDataset.counts[c]})` : ""}
                </button>
              ))}
            </div>

            {/* Samples Grid */}
            {loadingSamples ? (
              <div className="py-12 text-center text-xs text-slate-500 font-mono">
                Loading sample images…
              </div>
            ) : samples.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-500">
                No samples match the selected class filter.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {samples.map((s) => {
                  const analysis = analysisResults[s.id];
                  const impStatus = importStatus[s.id];
                  const isAnalyzing = analyzingId === s.id;
                  const isImporting = importingId === s.id;

                  return (
                    <div
                      key={s.id}
                      className="bg-[#fbfaf7] border border-line rounded-lg overflow-hidden flex flex-col p-2.5 gap-2"
                    >
                      {/* Image Preview */}
                      <div className="relative aspect-square bg-[#0e0f11] rounded overflow-hidden">
                        <AuthenticatedImage
                          src={s.thumbnailUrl || getImagingDatasetThumbnailUrl(activeDatasetName, s.id)}
                          alt={s.filename}
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute top-1.5 left-1.5">
                          <Tag tone={s.class.toLowerCase().includes("normal") || s.class.toLowerCase().includes("no_tumor") ? "normal" : "high"}>
                            {s.class}
                          </Tag>
                        </span>
                      </div>

                      {/* Sample Info */}
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                        <span className="truncate max-w-[130px]" title={s.filename}>
                          {s.id}
                        </span>
                        {s.width && (
                          <span>
                            {s.width}×{s.height}
                          </span>
                        )}
                      </div>

                      {/* Analysis Result Banner (if analyzed) */}
                      {analysis && (
                        <div
                          className={`p-2 rounded text-xs border ${
                            analysis.error
                              ? "bg-red-50 border-red-200 text-red-700"
                              : analysis.matches
                              ? "bg-green-50 border-green-200 text-green-900"
                              : "bg-amber-50 border-amber-200 text-amber-900"
                          }`}
                        >
                          {analysis.error ? (
                            <span>{analysis.error}</span>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center justify-between font-medium">
                                <span>Pred: {analysis.predicted}</span>
                                <span className="font-mono text-[10px]">
                                  {(analysis.score * 100).toFixed(0)}%
                                </span>
                              </div>
                              <span className="text-[10px]">
                                {analysis.matches ? "✓ Matches ground truth" : "✗ Disagrees with ground truth"}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Import Status Banner */}
                      {impStatus && (
                        <div
                          className={`p-1.5 rounded text-[11px] border ${
                            impStatus.error
                              ? "bg-red-50 border-red-200 text-red-700"
                              : "bg-blue-50 border-blue-200 text-blue-900"
                          }`}
                        >
                          {impStatus.error ? impStatus.error : `✓ Imported into ${impStatus.patientId}`}
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="grid grid-cols-2 gap-1.5 mt-auto pt-1">
                        <button
                          type="button"
                          onClick={() => handleAnalyzeSample(s)}
                          disabled={isAnalyzing}
                          className="btn-secondary h-7 text-[11px] px-2 font-medium"
                        >
                          {isAnalyzing ? "Analyzing…" : "Analyze"}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleImportSample(s)}
                          disabled={isImporting}
                          className="btn-secondary h-7 text-[11px] px-1 font-medium truncate"
                          title="Import to demo patient"
                        >
                          {isImporting ? "Importing…" : "Import"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
