"use strict";
const options = document.querySelector('.composer-options'), toolbar = document.querySelector('.chat-toolbar');toolbar.after(options);
const input = document.getElementById('input');input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';});
document.getElementById('privacy-pick').addEventListener('change',async e=>{try{await window.kai.call('assistant.privacy',{privacyMode:e.target.value});await refresh();}catch(err){addMsg('error',err.message);}});
document.addEventListener('click',event=>{const a=event.target.closest('a[href]');if(!a)return;event.preventDefault();void window.kai.call('assistant.external',{url:a.href}).catch(err=>addMsg('error',err.message));});

window.kai.onEvent("kai-plugin:navigate", value => { if (value?.section === "providers" || value?.section === "settings") activateView("settings"); else if (value?.section === "chat") activateView("chat"); });
window.addEventListener("kai-preferences-error", event => addMsg("error", event.detail || "Assistant preferences could not be saved."));
// The shared credit account now lives in Core. Keep the original purchase and
// saved-run actions reachable from this separately installed chat window.
window.addEventListener("kai-network-add-koin", () => activateView("buy-credits"));
document.getElementById("network-retry-purchase").addEventListener("click", () => activateView("buy-credits"));
const resultsButton = document.createElement("button"); resultsButton.textContent = "Research & agent results"; resultsButton.className = "small"; resultsButton.addEventListener("click", () => activateView("recovery")); document.querySelector("#view-settings .settings-card").appendChild(resultsButton);
