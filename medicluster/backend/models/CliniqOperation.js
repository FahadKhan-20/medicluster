const {defineModel,schema}=require('../db/model');
module.exports=defineModel('CliniqOperation',schema({
  actor:{type:String,required:true},tool:{type:String,required:true},arguments:{type:Object,required:true},
  location:Object,selectedPatient:Object,status:{type:String,enum:['PROPOSED','RUNNING','SUCCEEDED','FAILED','CANCELLED'],required:true},
  result:Object,error:String,expiresAt:{type:Date,required:true}
},{timestamps:true}));
