// notifications.js

let allNotifications = {
    unread: [],
    read: []
};
let currentNotificationFilter = 'all'; // 'all', 'unread', 'read'
let notificationCheckInterval = null; 
let currentlySelectedNotificationId = null; // To track the selected notification in the panel

// --- Core Notification Logic --- (generateNotificationId, loadNotificationsFromServer, createNewNotification, etc. remain the same)
function generateNotificationId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

async function loadNotificationsFromServer() {
    try {
        const data = await fetchAPI('/api/notifications'); 
        if (data && typeof data.unread !== 'undefined' && typeof data.read !== 'undefined') {
            allNotifications.unread = Array.isArray(data.unread) ? data.unread : [];
            allNotifications.read = Array.isArray(data.read) ? data.read : [];
            allNotifications.unread.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            allNotifications.read.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        } else {
            console.warn("Received invalid data structure for notifications from server.", data);
            allNotifications = { unread: [], read: [] };
        }
    } catch (error) {
        console.error("Failed to load notifications from server:", error);
        allNotifications = { unread: [], read: [] }; 
    }
    renderNotificationsDropdown();
    if (document.getElementById('notifications-panel-page')?.classList.contains('active')) {
        renderNotificationsPanel();
        // If a notification was selected, try to re-show its detail
        if (currentlySelectedNotificationId) {
            const stillExists = [...allNotifications.unread, ...allNotifications.read].find(n => n.id === currentlySelectedNotificationId);
            if (stillExists) {
                showNotificationDetail(currentlySelectedNotificationId, false); // false to not mark as read again if already handled
            } else {
                document.getElementById('notification-detail-view-area')?.classList.add('hidden');
                currentlySelectedNotificationId = null;
            }
        }
    }
    updateNotificationBellIndicator();
}


async function createNewNotification(headline, message, type = 'info', detailsLink = '#') {
    if (!headline || !message) {
        console.warn("Cannot create notification without headline or message.");
        return;
    }

    const newNotification = {
        id: generateNotificationId(),
        headline: headline,
        message: message,
        timestamp: new Date().toISOString(),
        type: type, 
        read: false, 
        detailsLink: detailsLink || '#'
    };

    try {
        await fetchAPI('/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newNotification)
        });
        await loadNotificationsFromServer(); 
        
        if (typeof showToast === 'function') { 
            showToast(`${headline}: ${message.substring(0, 30)}...`, type);
        }
    } catch (error) {
        console.error("Failed to create notification on server:", error);
    }
}

async function markNotificationAsRead(notificationId, fromPanel = false) {
    try {
        await fetchAPI(`/api/notifications/${notificationId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: true })
        });
        await loadNotificationsFromServer(); 
    } catch (error) {
        console.error(`Failed to mark notification ${notificationId} as read on server:`, error);
    }
}

async function markNotificationAsUnread(notificationId, fromPanel = false) {
    try {
        await fetchAPI(`/api/notifications/${notificationId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: false })
        });
        await loadNotificationsFromServer(); 
    } catch (error) {
        console.error(`Failed to mark notification ${notificationId} as unread on server:`, error);
    }
}

async function markAllDropdownNotificationsAsRead() { 
    try {
        await fetchAPI('/api/notifications/mark-all-read', { method: 'PUT' });
        await loadNotificationsFromServer(); 
    } catch (error) {
        console.error("Failed to mark all dropdown notifications as read on server:", error);
    }
}

async function markAllPanelNotificationsAsRead() { 
    try {
        await fetchAPI('/api/notifications/mark-all-read', { method: 'PUT' });
        await loadNotificationsFromServer(); 
    } catch (error) {
        console.error("Failed to mark all panel notifications as read on server:", error);
    }
}

async function deleteNotification(notificationId, fromPanel = false) {
    try {
        await fetchAPI(`/api/notifications/${notificationId}`, { method: 'DELETE' });
        if (typeof showToast === 'function') {
            showToast('Notification deleted.', 'info');
        }
        await loadNotificationsFromServer(); 
        if (fromPanel && currentlySelectedNotificationId === notificationId) {
            document.getElementById('notification-detail-view-area')?.classList.add('hidden');
            currentlySelectedNotificationId = null;
        }
    } catch (error) {
        console.error(`Failed to delete notification ${notificationId} from server:`, error);
    }
}


// --- UI Rendering ---

function formatTimeAgo(isoTimestamp) {
    const date = new Date(isoTimestamp);
    const now = new Date();
    const seconds = Math.round((now - date) / 1000);
    const minutes = Math.round(seconds / 60);
    const hours = Math.round(minutes / 60);
    const days = Math.round(hours / 24);

    if (seconds < 60) return `${seconds} sec ago`;
    if (minutes < 60) return `${minutes} min ago`;
    if (hours < 24) return `${hours} hr ago`;
    return `${days} day(s) ago`;
}

function updateNotificationBellIndicator() {
    const notificationIndicator = document.getElementById('notification-indicator');
    if (notificationIndicator) {
        notificationIndicator.classList.toggle('visible', allNotifications.unread.length > 0);
    }
}

function renderNotificationsDropdown() {
    const notificationListEl = document.getElementById('notification-list');
    if (!notificationListEl) return;

    const unreadNotifications = allNotifications.unread;
    const readNotifications = allNotifications.read;
    
    const combinedForDropdown = [...unreadNotifications, ...readNotifications];

    if (combinedForDropdown.length === 0) {
        notificationListEl.innerHTML = `<li class="p-4 text-center text-sm text-gray-500">No new notifications.</li>`;
        updateNotificationBellIndicator();
        return;
    }

    notificationListEl.innerHTML = ''; 
    const displayCount = Math.min(combinedForDropdown.length, 7); 

    for (let i = 0; i < displayCount; i++) {
        const n = combinedForDropdown[i];
        const li = document.createElement('li');
        li.className = `notification-item ${n.read ? 'read' : 'unread'} hover:bg-gray-100`; // Added hover
        li.dataset.notificationId = n.id;
        li.innerHTML = `
            <div class="notification-headline ${!n.read ? 'font-semibold' : 'font-normal'}">${n.headline}</div>
            <div class="notification-message text-xs">${n.message.substring(0, 70)}${n.message.length > 70 ? '...' : ''}</div>
            <div class="notification-timestamp text-xs text-gray-500">${formatTimeAgo(n.timestamp)}</div>
            ${!n.read ? `<button class="mark-as-read-btn text-xs text-blue-500 hover:underline" onclick="event.stopPropagation(); markNotificationAsRead('${n.id}')">Mark as read</button>` : ''}
        `;
        li.addEventListener('click', (e) => {
            if (!e.target.classList.contains('mark-as-read-btn')) {
                if (!n.read) markNotificationAsRead(n.id); 
                
                document.getElementById('notification-popup').classList.add('hidden');

                if (n.detailsLink && n.detailsLink !== '#') {
                    const targetPanelId = n.detailsLink.startsWith('#') ? n.detailsLink.substring(1) : null;
                    if (targetPanelId && typeof setActivePanel === 'function') {
                        setActivePanel(targetPanelId, targetPanelId.replace('-panel', '').replace('-page','').split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '));
                    } else {
                        window.location.href = n.detailsLink;
                    }
                } else if (typeof setActivePanel === 'function') {
                     setActivePanel('notifications-panel-page', 'All Notifications');
                     showNotificationDetail(n.id); 
                }
            }
        });
        notificationListEl.appendChild(li);
    }
    updateNotificationBellIndicator();
}

function setActiveNotificationRow(notificationId) {
    const panelContentArea = document.getElementById('notifications-panel-content-area');
    // Remove active class from previously selected row
    const currentlyActive = panelContentArea?.querySelector('.notification-inbox-item.active-notification-row');
    if (currentlyActive) {
        currentlyActive.classList.remove('active-notification-row', 'bg-blue-100', 'border-l-4', 'border-blue-500');
        currentlyActive.classList.add('hover:bg-gray-100');
    }

    // Add active class to the new row
    const newActiveRow = panelContentArea?.querySelector(`.notification-inbox-item[data-notification-id="${notificationId}"]`);
    if (newActiveRow) {
        newActiveRow.classList.add('active-notification-row', 'bg-blue-100', 'border-l-4', 'border-blue-500');
        newActiveRow.classList.remove('hover:bg-gray-100');
    }
    currentlySelectedNotificationId = notificationId;
}

function renderNotificationsPanel() {
    const panelContentArea = document.getElementById('notifications-panel-content-area');
    const detailViewArea = document.getElementById('notification-detail-view-area');
    if (!panelContentArea) return;

    let notificationsToDisplay = [];

    if (currentNotificationFilter === 'all') {
        notificationsToDisplay = [...allNotifications.unread, ...allNotifications.read];
    } else if (currentNotificationFilter === 'unread') {
        notificationsToDisplay = [...allNotifications.unread];
    } else if (currentNotificationFilter === 'read') {
        notificationsToDisplay = [...allNotifications.read];
    }
    
    if (currentNotificationFilter === 'all') {
        notificationsToDisplay.sort((a, b) => {
            if (a.read === b.read) return new Date(b.timestamp) - new Date(a.timestamp);
            return a.read ? 1 : -1; 
        });
    } else { 
        notificationsToDisplay.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    if (notificationsToDisplay.length === 0) {
        panelContentArea.innerHTML = `<p class="text-center text-gray-500 py-8">No notifications to display for this filter.</p>`;
        if(detailViewArea) detailViewArea.classList.add('hidden');
        currentlySelectedNotificationId = null;
        return;
    }

    panelContentArea.innerHTML = ''; 
    notificationsToDisplay.forEach(n => {
        const itemDiv = document.createElement('div');
        // Gmail-like row styling
        itemDiv.className = `notification-inbox-item flex items-start p-3 border-b border-gray-200 cursor-pointer hover:bg-gray-100 transition-colors duration-150 ${n.read ? 'bg-gray-100 text-gray-900 font-semibold' : 'bg-white font-bold text-800'}`;
        if (n.id === currentlySelectedNotificationId) {
            itemDiv.classList.add('active-notification-row', 'bg-blue-100', 'border-l-4', 'border-blue-500');
            itemDiv.classList.remove('hover:bg-gray-100');
        }
        itemDiv.dataset.notificationId = n.id;
        
        // Determine a "sender" or source for the notification (can be improved)
        let sender = "System";
        if (n.headline.toLowerCase().includes("book")) sender = "Book Mgmt";
        else if (n.headline.toLowerCase().includes("customer")) sender = "Customer Mgmt";
        else if (n.headline.toLowerCase().includes("order")) sender = "Order Mgmt";
        else if (n.headline.toLowerCase().includes("author")) sender = "Author Mgmt";
        else if (n.headline.toLowerCase().includes("publisher")) sender = "Publisher Mgmt";
        else if (n.headline.toLowerCase().includes("genre")) sender = "Genre Mgmt";


        itemDiv.innerHTML = `
            <div class="flex-shrink-0 w-24 truncate text-sm pr-2 ${n.read ? 'text-gray-500' : 'text-gray-700'}">${sender}</div>
            <div class="flex-grow min-w-0">
                <div class="headline truncate text-sm ${n.read ? '' : 'font-semibold'}">${n.headline}</div>
                <div class="message-snippet truncate text-xs ${n.read ? 'text-gray-500' : 'text-gray-600'}">${n.message.substring(0, 80)}${n.message.length > 80 ? '...' : ''}</div>
            </div>
            <div class="flex-shrink-0 text-xs text-gray-400 ml-3 w-20 text-right">${formatTimeAgo(n.timestamp)}</div>
            <div class="notification-actions flex-shrink-0 ml-3 space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                 ${!n.read ? 
                    `<button title="Mark as Read" class="text-gray-500 hover:text-blue-600 p-1 rounded-full hover:bg-gray-200" onclick="event.stopPropagation(); markNotificationAsRead('${n.id}', true)"><i class="fas fa-envelope-open-text"></i></button>` :
                    `<button title="Mark as Unread" class="text-gray-500 hover:text-yellow-600 p-1 rounded-full hover:bg-gray-200" onclick="event.stopPropagation(); markNotificationAsUnread('${n.id}', true)"><i class="fas fa-envelope"></i></button>`
                }
                <button title="Delete" class="text-gray-500 hover:text-red-600 p-1 rounded-lg hover:bg-gray-200" onclick="event.stopPropagation(); deleteNotification('${n.id}', true)"><i class="fas fa-trash"></i></button>
            </div>
        `;
        // Add group class for hover effect on actions
        itemDiv.classList.add('group');

        itemDiv.addEventListener('click', () => {
            showNotificationDetail(n.id, true); // true to mark as read on click
            setActiveNotificationRow(n.id);
        });
        panelContentArea.appendChild(itemDiv);
    });
    // If no notification is currently selected, hide the detail view
    if (!currentlySelectedNotificationId && detailViewArea) {
        detailViewArea.classList.add('hidden');
    }
}

function showNotificationDetail(notificationId, markReadOnClick = true) {
    const detailViewArea = document.getElementById('notification-detail-view-area');
    if (!detailViewArea) return;

    const notification = [...allNotifications.unread, ...allNotifications.read].find(n => n.id === notificationId);

    if (notification) {
        detailViewArea.innerHTML = `
            <div class="flex justify-between items-center mb-4 pb-2 border-b">
                <h3 class="text-lg font-semibold text-gray-800">${notification.headline}</h3>
                <button class="text-gray-400 hover:text-gray-600 text-xl p-1" onclick="document.getElementById('notification-detail-view-area').classList.add('hidden'); setActiveNotificationRow(null); currentlySelectedNotificationId = null;">×</button>
            </div>
            <div class="mb-3">
                <p class="text-xs text-gray-600 font-semibold">Received: ${new Date(notification.timestamp).toLocaleString()}</p>
                <p class="text-xs text-gray-600 font-semibold">Status: <span class="${notification.read ? 'text-green-600' : 'text-red-600 font-semibold'}">${notification.read ? 'Read' : 'Unread'}</span></p>
            </div>
            <div class="prose prose-sm max-w-none text-gray-800 leading-relaxed">
                ${notification.message.replace(/\n/g, '<br>')}
            </div>
            <div class="mt-6 pt-4 border-t flex space-x-2">
                ${!notification.read ? 
                    `<button class="btn-primary text-sm px-3 py-1 rounded-md" onclick="markNotificationAsRead('${notification.id}', true); showNotificationDetail('${notification.id}', false);">Mark as Read</button>` :
                    `<button class="btn-secondary text-sm px-3 py-1 rounded-md" onclick="markNotificationAsUnread('${notification.id}', true); showNotificationDetail('${notification.id}', false);">Mark as Unread</button>`
                }
                ${notification.detailsLink && notification.detailsLink !== '#' ? 
                    `<a href="${notification.detailsLink}" onclick="handleNotificationDetailLinkClick(event, '${notification.detailsLink}')" class="btn-secondary text-sm px-3 py-1 rounded-md">View Details</a>` : ''}
                <button class="btn-danger bg-red-500 text-white text-sm px-3 py-1 rounded-md" onclick="deleteNotification('${notification.id}', true)">Delete</button>
            </div>
        `;
        detailViewArea.classList.remove('hidden');
        
        if (markReadOnClick && !notification.read) {
            markNotificationAsRead(notification.id, true); 
        }
        setActiveNotificationRow(notificationId); // Highlight the row in the list
    } else {
        detailViewArea.innerHTML = `<p class="text-center text-gray-500">Notification details not found.</p>`;
        detailViewArea.classList.remove('hidden');
        currentlySelectedNotificationId = null;
    }
}


function handleNotificationDetailLinkClick(event, link) {
    event.preventDefault();
    document.getElementById('notification-detail-view-area').classList.add('hidden');
    setActiveNotificationRow(null); // Clear selection
    currentlySelectedNotificationId = null;

    if (link.startsWith('#') && typeof setActivePanel === 'function') {
        const targetPanelId = link.substring(1);
        setActivePanel(targetPanelId, targetPanelId.replace('-panel', '').replace('-page','').split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '));
    } else {
        window.location.href = link;
    }
}

// --- Initialization and Event Listeners ---

async function initializeNotificationSystem() {
    await loadNotificationsFromServer(); 

    const notificationBellButton = document.getElementById('notification-bell-button');
    const notificationPopup = document.getElementById('notification-popup');
    const markAllReadButtonDropdown = document.getElementById('mark-all-read-button'); 

    notificationBellButton?.addEventListener('click', (e) => {
        e.stopPropagation();
        notificationPopup?.classList.toggle('hidden');
        if (!notificationPopup?.classList.contains('hidden')) {
            renderNotificationsDropdown(); 
        }
    });

    markAllReadButtonDropdown?.addEventListener('click', (e) => {
        e.stopPropagation();
        markAllDropdownNotificationsAsRead();
    });
    
    // Global click listener to close dropdown
    document.addEventListener('click', (e) => {
        if (notificationPopup && !notificationPopup.classList.contains('hidden') &&
            !notificationPopup.contains(e.target) && // Click was outside the popup
            e.target !== notificationBellButton && !notificationBellButton.contains(e.target) // And not on the bell button itself
           ) {
            notificationPopup.classList.add('hidden');
        }
    });

    // Event listeners for the main notification panel filters and actions
    document.getElementById('filter-all-notifs')?.addEventListener('click', () => {
        currentNotificationFilter = 'all';
        renderNotificationsPanel();
    });
    document.getElementById('filter-unread-notifs')?.addEventListener('click', () => {
        currentNotificationFilter = 'unread';
        renderNotificationsPanel();
    });
    document.getElementById('filter-read-notifs')?.addEventListener('click', () => {
        currentNotificationFilter = 'read';
        renderNotificationsPanel();
    });
    document.getElementById('panel-mark-all-read-button')?.addEventListener('click', markAllPanelNotificationsAsRead);

    // Optional: Set up polling for new notifications from server
    // notificationCheckInterval = setInterval(loadNotificationsFromServer, 60000); 
}

function clearNotificationInterval() {
    if (notificationCheckInterval) {
        clearInterval(notificationCheckInterval);
        notificationCheckInterval = null;
    }
}