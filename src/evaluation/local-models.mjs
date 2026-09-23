import { pipeline } from '@huggingface/transformers';

export const MODEL_LOCK = {
  embedding: { id:'Xenova/all-MiniLM-L6-v2', revision:'751bff37182d3f1213fa05d7196b954e230abad9', purpose:'sentence embedding for dense retrieval' },
  reranker: { id:'Xenova/ms-marco-MiniLM-L-6-v2', revision:'a09144355adeed5f58c8ed011d209bf8ee5a1fec', purpose:'cross-encoder relevance score for query/passage pairs' }
};
let embeddingPipeline, rerankerPipeline;

async function getEmbeddingPipeline() {
  if (!embeddingPipeline) embeddingPipeline = pipeline('feature-extraction',MODEL_LOCK.embedding.id,{revision:MODEL_LOCK.embedding.revision,dtype:'q8'});
  return embeddingPipeline;
}
async function getRerankerPipeline() {
  if (!rerankerPipeline) rerankerPipeline = pipeline('text-classification',MODEL_LOCK.reranker.id,{revision:MODEL_LOCK.reranker.revision,dtype:'q8'});
  return rerankerPipeline;
}
export function cosine(a,b) { let dot=0,aa=0,bb=0; for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];} return dot/(Math.sqrt(aa*bb)||1); }

export async function embedTexts(texts) {
  const pipe=await getEmbeddingPipeline(), vectors=[];
  for(const text of texts) {
    const tensor=await pipe(String(text).slice(0,5000),{truncation:true,max_length:256});
    const [,seq,dim]=tensor.dims, values=tensor.data, vector=new Float32Array(dim);
    for(let token=0;token<seq;token++) for(let j=0;j<dim;j++) vector[j]+=values[token*dim+j];
    for(let j=0;j<dim;j++) vector[j]/=seq;
    let norm=Math.sqrt(vector.reduce((s,x)=>s+x*x,0))||1;
    vectors.push(Float32Array.from(vector,x=>x/norm));
  }
  return vectors;
}

export async function rerankPairs(query, passages) {
  const pipe=await getRerankerPipeline(), scores=[];
  for(const passage of passages) {
    const encoded=await pipe.tokenizer(query,{text_pair:passage,truncation:true,max_length:512});
    const output=await pipe.model(encoded);
    scores.push(Number(output.logits.data[0]));
  }
  return scores;
}

export async function warmupLocalModels() {
  const start=performance.now();
  const [vector]=await embedTexts(['SKR local embedding model warmup.']);
  const [rerank]=await rerankPairs('warmup',['A retrieval relevance candidate.']);
  return {status:'ready',models:MODEL_LOCK,dimensions:vector.length,warmupRerankerScore:rerank,wallMs:performance.now()-start,provider:'local CPU ONNX; no token or API cost'};
}
