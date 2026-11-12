import {useEffect,useRef,useState} from 'react';
import api,{getToken,getPatientToken} from '../api/apiClient';
function validSource(source){return /^\/api\/media\/(?:file|preview)\/[a-fA-F0-9]{24}$/.test(source);}
export function PrivateImage({source,onError,...props}){
  const [image,setImage]=useState(null),errorHandler=useRef(onError);errorHandler.current=onError;
  const token=window.location.pathname.startsWith('/app/')?getPatientToken():getToken();
  useEffect(()=>{
    let active=true,url;const controller=new AbortController();
    if(validSource(source))api.get(source.slice(4),{responseType:'blob',signal:controller.signal}).then(r=>{
      if(!active)return;url=URL.createObjectURL(r.data);setImage({source,token,url});
    }).catch(e=>{if(active&&e.code!=='ERR_CANCELED')errorHandler.current?.(e);});
    return ()=>{active=false;controller.abort();if(url)URL.revokeObjectURL(url);};
  },[source,token]);
  return <img {...props} src={image?.source===source&&image?.token===token?image.url:undefined} onError={onError}/>;
}
export function PrivateFileLink({source,filename,children,...props}){
  const [error,setError]=useState('');const urls=useRef([]),controller=useRef(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();urls.current.forEach(u=>URL.revokeObjectURL(u));};},[]);
  const open=async()=>{
    if(!validSource(source))return;setError('');
    const currentToken=()=>window.location.pathname.startsWith('/app/')?getPatientToken():getToken();
    const token=currentToken();controller.current?.abort();controller.current=new AbortController();
    try{
      const r=await api.get(source.slice(4),{responseType:'blob',signal:controller.current.signal});
      if(!alive.current||token!==currentToken())return;
      const url=URL.createObjectURL(r.data);urls.current.push(url);
      const link=document.createElement('a');link.href=url;link.download=filename||'document';link.click();
    }catch(e){if(alive.current&&e.code!=='ERR_CANCELED')setError('File unavailable. Check sign-in and retry.');}
  };
  return <><button type="button" {...props} onClick={open}>{children}</button>{error&&<span role="alert" className="text-xs text-red-700">{error}</span>}</>;
}
