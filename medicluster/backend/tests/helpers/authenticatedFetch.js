/** Exercise protected integration endpoints using a real fixture staff JWT. */
module.exports = function authenticatedFetch(t, original, token) {
  if(!token){
    const previous=process.env.JWT_SECRET;
    if(!previous)process.env.JWT_SECRET='media-integration-fixture-secret-at-least-32-characters';
    token=require('../../middleware/auth').signToken({_id:'fixture-staff'});
    t.after(()=>{if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;});
  }
  return (url,options={})=>{
    const headers=new Headers(options.headers);
    if(!headers.has('authorization'))headers.set('authorization',`Bearer ${token}`);
    return original(url,{...options,headers});
  };
};
