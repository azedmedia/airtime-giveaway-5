require("dotenv").config();
const express=require("express"), helmet=require("helmet"), rateLimit=require("express-rate-limit"), path=require("path"), fs=require("fs"), Database=require("better-sqlite3");
const app=express(), PORT=Number(process.env.PORT||3000), LIMIT=5;
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],fontSrc:["'self'","https://fonts.gstatic.com"],scriptSrc:["'self'"],imgSrc:["'self'","data:"],connectSrc:["'self'"]}}}));
app.use(express.json({limit:"3kb"})); app.use(express.static(path.join(__dirname,"public")));
fs.mkdirSync(path.join(__dirname,"data"),{recursive:true});
const db=new Database(path.join(__dirname,"data","airtime.sqlite"));
db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS claims(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, network TEXT NOT NULL CHECK(network IN ('MTN','GLO','AIRTEL')), created_at TEXT NOT NULL DEFAULT (datetime('now')))");
app.use("/api/",rateLimit({windowMs:60000,limit:20,standardHeaders:"draft-7",legacyHeaders:false}));
app.get("/api/status",(req,res)=>{const count=db.prepare("SELECT COUNT(*) count FROM claims").get().count;res.json({claimed:count,total:LIMIT,remaining:Math.max(0,LIMIT-count),full:count>=LIMIT})});
async function notify(phone,network,slot){
 const token=process.env.BOT_TOKEN,chat=process.env.ADMIN_CHAT_ID;
 if(!token||!chat){console.error("Telegram not configured");return false}
 try{const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:`📱 AIRTIME GIVEAWAY — NEW CLAIM\\n\\nSlot: ${slot}/5\\nReward: ₦100 airtime (manual top-up)\\nNetwork: ${network}\\nPhone: ${phone}\\n\\nNo airtime was sent automatically.`})});const j=await r.json();if(!r.ok||!j.ok)console.error(j.description||r.status);return r.ok&&j.ok}catch(e){console.error(e.message);return false}
}
app.post("/api/claim",(req,res)=>{
 const raw=typeof req.body?.phone==="string"?req.body.phone.trim():"",network=typeof req.body?.network==="string"?req.body.network.toUpperCase():"";
 const p=raw.replace(/[\\s()-]/g,""),phone=p.startsWith("+234")?"0"+p.slice(4):p.startsWith("234")?"0"+p.slice(3):p;
 if(!/^0[789][01]\\d{8}$/.test(phone))return res.status(400).json({error:"Enter a valid Nigerian mobile number, e.g. 08012345678."});
 if(!["MTN","GLO","AIRTEL"].includes(network))return res.status(400).json({error:"Choose MTN, Glo, or Airtel."});
 const tx=db.transaction(()=>{if(db.prepare("SELECT id FROM claims WHERE phone=?").get(phone))return{type:"duplicate"};if(db.prepare("SELECT COUNT(*) count FROM claims").get().count>=LIMIT)return{type:"full"};const r=db.prepare("INSERT INTO claims(phone,network) VALUES(?,?)").run(phone,network);return{type:"accepted",slot:Number(r.lastInsertRowid)}});
 let out;try{out=tx.immediate()}catch(e){console.error(e);return res.status(500).json({error:"Something went wrong. Please try again."})}
 if(out.type==="duplicate")return res.status(409).json({error:"This phone number has already entered. One entry per number."});
 if(out.type==="full")return res.status(410).json({error:"Airtime Fully Claimed",full:true});
 notify(phone,network,out.slot).then(ok=>{if(!ok)console.error("Telegram notification needs checking")});
 const count=db.prepare("SELECT COUNT(*) count FROM claims").get().count;
 res.status(201).json({success:true,slot:out.slot,remaining:Math.max(0,LIMIT-count),message:"Entry received. Airtime will be topped up manually; nothing was sent automatically."});
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log("Airtime giveaway running on "+PORT));
